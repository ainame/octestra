#!/usr/bin/env ruby

require 'json'
require 'digest'
require 'open3'
require 'optparse'
require 'thread'

class CommandError < StandardError
  attr_reader :stderr

  def initialize(message, stderr)
    super(message)
    @stderr = stderr
  end
end

class GitHubCLI
  TRANSIENT_ERROR = /(HTTP 429|secondary rate limit|rate limit exceeded|HTTP 5\d\d)/i

  def run(*arguments, input: nil, retries: 3)
    attempt = 0
    loop do
      stdout, stderr, status = Open3.capture3('gh', *arguments, stdin_data: input.to_s)
      return stdout if status.success?

      attempt += 1
      if attempt <= retries && stderr.match?(TRANSIENT_ERROR)
        sleep(2**(attempt - 1))
        next
      end
      raise CommandError.new("gh #{arguments.join(' ')} failed", stderr.strip)
    end
  end

  def json(*arguments, input: nil)
    JSON.parse(run(*arguments, input: input))
  rescue JSON::ParserError => error
    raise "gh returned invalid JSON: #{error.message}"
  end
end

class StateStore
  VERSION = 1

  attr_reader :path

  def initialize(path, manifest)
    @path = path
    @mutex = Mutex.new
    @manifest_hash = Digest::SHA256.hexdigest(JSON.generate(canonicalize(manifest)))
    @repository = manifest.fetch('repository')
    @resumed = File.exist?(@path)
    @data = @resumed ? load_state : new_state
    validate!
    persist unless @resumed
  end

  def resumed?
    @resumed
  end

  def epic(index)
    entry(:epics, index)
  end

  def task(index)
    entry(:tasks, index)
  end

  def record_epic(result)
    update(:epics, result.fetch(:index), result)
  end

  def mark_epic_project_added(result)
    update(:epics, result.fetch(:index), project_added: true)
  end

  def record_task(result)
    update(:tasks, result.fetch(:index), result.reject { |key, _| key == :task })
  end

  def mark_task_linked(result)
    update(:tasks, result.fetch(:index), linked: true)
  end

  def mark_status_initialized(result)
    update(:tasks, result.fetch(:index), status_initialized: true)
  end

  private

  def canonicalize(value)
    case value
    when Hash
      value.keys.sort.each_with_object({}) do |key, result|
        result[key] = canonicalize(value[key])
      end
    when Array
      value.map { |item| canonicalize(item) }
    else
      value
    end
  end

  def load_state
    JSON.parse(File.read(@path), symbolize_names: true)
  rescue JSON::ParserError => error
    raise "State file #{@path} is invalid JSON: #{error.message}"
  end

  def new_state
    {
      version: VERSION,
      manifest_sha256: @manifest_hash,
      repository: @repository,
      epics: [],
      tasks: []
    }
  end

  def validate!
    raise "Unsupported state version in #{@path}" unless @data[:version] == VERSION
    raise "State file #{@path} belongs to another repository" unless @data[:repository] == @repository
    return if @data[:manifest_sha256] == @manifest_hash

    raise "Manifest does not match state file #{@path}; use a new state path for a changed setup"
  end

  def entry(collection, index)
    @mutex.synchronize do
      value = @data.fetch(collection)[index]
      value&.dup
    end
  end

  def update(collection, index, attributes)
    @mutex.synchronize do
      current = @data.fetch(collection)[index] || { index: index }
      @data.fetch(collection)[index] = current.merge(attributes)
      persist
      @data.fetch(collection)[index].dup
    end
  end

  def persist
    temporary_path = "#{@path}.tmp"
    File.write(temporary_path, JSON.pretty_generate(@data) + "\n")
    File.rename(temporary_path, @path)
  end
end

class EpicSetup
  SUB_ISSUE_LIMIT = 100
  API_VERSION = '2026-03-10'

  def initialize(manifest, github:, parallel:, state:)
    @manifest = manifest
    @github = github
    @parallel = parallel
    @state = state
    @errors = []
    validate_manifest!
  end

  def run
    check_prerequisites!
    ensure_labels!
    status_field_id = find_status_field_id!
    epics = create_epics
    epics.each { |epic| add_epic_to_project(epic) }

    task_results = parallel_map(@tasks) { |task, index| create_task(task, index) }
    linked_results = link_tasks(task_results, epics)
    status_results = parallel_map(linked_results) { |result, _| initialize_status(result, status_field_id) }

    build_result(epics, task_results, linked_results, status_results)
  end

  private

  def validate_manifest!
    object!(@manifest, 'manifest')
    @repository = non_empty_string!(@manifest['repository'], 'repository')

    @project = object!(@manifest['project'], 'project')
    @project_owner = non_empty_string!(@project['owner'], 'project.owner')
    @project_number = positive_integer!(@project['number'], 'project.number')

    @status_field = @manifest.fetch('statusField', 'AI Task Status')
    non_empty_string!(@status_field, 'statusField')

    @epic = object!(@manifest['epic'], 'epic')
    @title = non_empty_string!(@epic['title'], 'epic.title')
    @skill = non_empty_string!(@epic['skill'], 'epic.skill')
    boolean!(@epic.fetch('draftPr', false), 'epic.draftPr')
    boolean!(@epic.fetch('skipValidation', false), 'epic.skipValidation')
    optional_string!(@epic.fetch('prompt', ''), 'epic.prompt')
    optional_string!(@epic.fetch('validationPrompt', ''), 'epic.validationPrompt')

    tasks = @manifest['tasks']
    raise 'tasks must be a non-empty array' unless tasks.is_a?(Array) && !tasks.empty?

    @tasks = tasks.each_with_index.map do |task, index|
      object!(task, "tasks[#{index}]")
      {
        'title' => non_empty_string!(task['title'], "tasks[#{index}].title"),
        'target' => optional_string!(task['target'], "tasks[#{index}].target"),
        'taskPrompt' => optional_string!(task.fetch('taskPrompt', ''), "tasks[#{index}].taskPrompt")
      }
    end
  end

  def object!(value, name)
    raise "#{name} must be an object" unless value.is_a?(Hash)

    value
  end

  def non_empty_string!(value, name)
    raise "#{name} must be a non-empty string" unless value.is_a?(String) && !value.strip.empty?

    value.strip
  end

  def optional_string!(value, name)
    raise "#{name} must be a string or null" unless value.nil? || value.is_a?(String)

    value
  end

  def positive_integer!(value, name)
    raise "#{name} must be a positive integer" unless value.is_a?(Integer) && value.positive?

    value
  end

  def boolean!(value, name)
    raise "#{name} must be true or false" unless value == true || value == false

    value
  end

  def check_prerequisites!
    @github.run('auth', 'status', retries: 0)
    @github.run('project', 'view', @project_number.to_s, '--owner', @project_owner, retries: 0)

    response = @github.json(
      'api', 'graphql',
      '-F', "owner=#{@project_owner}",
      '-F', "number=#{@project_number}",
      '-f', "query=#{project_workflows_query}"
    )
    workflows = response.dig('data', 'organization', 'projectV2', 'workflows', 'nodes') || []
    enabled = workflows.any? do |workflow|
      workflow['name'] == 'Auto-add sub-issues to project' && workflow['enabled'] == true
    end
    raise 'Enable the "Auto-add sub-issues to project" Project workflow before continuing' unless enabled
  end

  def project_workflows_query
    <<~GRAPHQL
      query($owner: String!, $number: Int!) {
        organization(login: $owner) {
          projectV2(number: $number) {
            workflows(first: 50) {
              nodes { name enabled }
            }
          }
        }
      }
    GRAPHQL
  end

  def ensure_labels!
    labels = @github.json('api', "repos/#{@repository}/labels?per_page=100").map { |label| label['name'] }
    create_label('octestra-epic', 'Octestra EPIC', 'D93F0B') unless labels.include?('octestra-epic')
    create_label(@skill, "Skill: #{@skill}", 'BFD4F2') unless labels.include?(@skill)
  end

  def create_label(name, description, color)
    payload = JSON.generate(name: name, description: description, color: color)
    @github.json('api', "repos/#{@repository}/labels", '--method', 'POST', '--input', '-', input: payload)
  end

  def find_status_field_id!
    fields = @github.json(
      'api', "/orgs/#{@repository.split('/').first}/issue-fields",
      '-H', "X-GitHub-Api-Version: #{API_VERSION}"
    )
    field = fields.find do |candidate|
      candidate['name'] == @status_field && candidate['data_type'] == 'single_select'
    end
    raise "The #{@status_field.inspect} single-select Issue Field was not found" unless field

    field.fetch('id')
  end

  def create_epics
    count = (@tasks.length.to_f / SUB_ISSUE_LIMIT).ceil
    first_url = nil
    Array.new(count) do |index|
      saved = @state.epic(index)
      if saved
        first_url ||= saved.fetch(:url)
        next saved
      end

      part = index + 1
      prompt = @epic.fetch('prompt', '').to_s
      prompt = [prompt, "Related EPIC: #{first_url}"].reject(&:empty?).join("\n\n") if first_url
      response = create_issue(
        title: epic_title(part, count),
        body: epic_body(prompt),
        labels: ['octestra-epic']
      )
      first_url ||= response.fetch('html_url')
      @state.record_epic(issue_result(response, index))
    end
  end

  def epic_title(part, count)
    base = "[migration] #{@title}"
    count == 1 ? base : "#{base} (Part #{part})"
  end

  def epic_body(prompt)
    sections = [
      "### Configuration\n\n```epic-config\nid: #{@skill}\nskill: #{@skill}\ndraft_pr: #{@epic.fetch('draftPr', false)}\nskip_validation: #{@epic.fetch('skipValidation', false)}\n```"
    ]
    unless prompt.empty?
      sections << "### Additional information\n\n```epic-prompt\n#{prompt}\n```"
    end
    sections << "### Additional Validation information\n\n```validation-prompt\n#{@epic.fetch('validationPrompt', '')}\n```"
    sections.join("\n\n")
  end

  def add_epic_to_project(epic)
    return if epic[:project_added]

    @github.run(
      'project', 'item-add', @project_number.to_s,
      '--owner', @project_owner,
      '--url', epic.fetch(:url)
    )
    epic.merge!(@state.mark_epic_project_added(epic))
  end

  def create_task(task, index)
    saved = @state.task(index)
    return saved.merge(task: task) if saved

    response = create_issue(
      title: task.fetch('title'),
      body: task_body(task),
      labels: [@skill]
    )
    result = issue_result(response, index).merge(task: task)
    @state.record_task(result)
    result
  rescue StandardError => error
    error_result(index, task, 'create', error)
  end

  def create_issue(title:, body:, labels:)
    payload = JSON.generate(title: title, body: body, labels: labels)
    @github.json('api', "repos/#{@repository}/issues", '--method', 'POST', '--input', '-', input: payload)
  end

  def task_body(task)
    <<~BODY.strip
      ### Task configuration

      ```task-config
      target: #{JSON.generate(task['target'])}
      ```

      ### Task prompt

      ```task-prompt
      #{task['taskPrompt']}
      ```
    BODY
  end

  def issue_result(response, index)
    {
      index: index,
      id: response.fetch('id'),
      number: response.fetch('number'),
      url: response.fetch('html_url')
    }
  end

  def link_tasks(results, epics)
    results.each_with_object([]) do |result, linked|
      next if result[:error]
      if result[:linked]
        linked << result
        next
      end

      epic = epics.fetch(result.fetch(:index) / SUB_ISSUE_LIMIT)
      payload = JSON.generate(sub_issue_id: result.fetch(:id))
      @github.run(
        'api', "repos/#{@repository}/issues/#{epic.fetch(:number)}/sub_issues",
        '--method', 'POST', '--input', '-',
        input: payload
      )
      result.merge!(@state.mark_task_linked(result))
      linked << result
    rescue StandardError => error
      @errors << error_result(result.fetch(:index), result[:task], 'link', error)
    end
  end

  def initialize_status(result, field_id)
    return result if result[:status_initialized]

    payload = JSON.generate(
      issue_field_values: [{ field_id: field_id, value: 'Todo' }]
    )
    @github.run(
      'api', "repos/#{@repository}/issues/#{result.fetch(:number)}/issue-field-values",
      '--method', 'POST',
      '-H', "X-GitHub-Api-Version: #{API_VERSION}",
      '--input', '-',
      input: payload
    )
    result.merge!(@state.mark_status_initialized(result))
    result
  rescue StandardError => error
    error_result(result.fetch(:index), result[:task], 'status', error)
  end

  def parallel_map(items)
    queue = Queue.new
    items.each_with_index { |item, index| queue << [item, index] }
    results = Array.new(items.length)
    workers = [@parallel, items.length].min.times.map do
      Thread.new do
        loop do
          item, index = queue.pop(true)
          results[index] = yield(item, index)
        rescue ThreadError
          break
        end
      end
    end
    workers.each(&:join)
    results
  end

  def error_result(index, task, stage, error)
    {
      index: index,
      title: task && task['title'],
      stage: stage,
      error: error.message
    }
  end

  def build_result(epics, task_results, linked_results, status_results)
    @errors.concat(task_results.select { |result| result[:error] })
    status_errors = status_results.select { |result| result[:error] }
    @errors.concat(status_errors)
    {
      'repository' => @repository,
      'project' => "https://github.com/orgs/#{@project_owner}/projects/#{@project_number}",
      'resumed' => @state.resumed?,
      'statePath' => @state.path,
      'epics' => epics.map { |epic| epic.transform_keys(&:to_s) },
      'tasksRequested' => @tasks.length,
      'tasksCreated' => task_results.count { |result| !result[:error] },
      'tasksLinked' => linked_results.length,
      'statusesInitialized' => status_results.count { |result| !result[:error] },
      'errors' => @errors
    }
  end
end

if $PROGRAM_NAME == __FILE__
  options = { parallel: 8, result: nil, state: nil }
  parser = OptionParser.new do |opts|
    opts.banner = 'Usage: ruby setup_epic.rb MANIFEST [--parallel N] [--state PATH] [--result PATH]'
    opts.on('--parallel N', Integer, 'Maximum concurrent GitHub operations (default: 8)') do |value|
      options[:parallel] = value
    end
    opts.on('--state PATH', 'Resume from or write checkpoints to PATH') { |value| options[:state] = value }
    opts.on('--result PATH', 'Write the result JSON to PATH') { |value| options[:result] = value }
  end
  parser.parse!

  manifest_path = ARGV.shift
  abort parser.to_s unless manifest_path && ARGV.empty?
  abort '--parallel must be a positive integer' unless options[:parallel].positive?

  begin
    manifest = JSON.parse(File.read(manifest_path))
    state_path = options[:state] || "#{manifest_path}.state.json"
    result = EpicSetup.new(
      manifest,
      github: GitHubCLI.new,
      parallel: options[:parallel],
      state: StateStore.new(state_path, manifest)
    ).run
    result_path = options[:result] || "#{manifest_path}.result.json"
    File.write(result_path, JSON.pretty_generate(result) + "\n")

    puts "Created #{result['epics'].length} EPIC(s)"
    puts "Created #{result['tasksCreated']}/#{result['tasksRequested']} task issue(s)"
    puts "Linked #{result['tasksLinked']} task issue(s)"
    puts "Initialized #{result['statusesInitialized']} task status value(s)"
    puts "Result: #{result_path}"

    unless result['errors'].empty?
      result['errors'].each do |error|
        warn "#{error[:stage].upcase} FAILED task #{error[:index] + 1} (#{error[:title]}): #{error[:error]}"
      end
      exit 1
    end
  rescue StandardError => error
    warn "Octestra setup failed: #{error.message}"
    exit 1
  end
end
