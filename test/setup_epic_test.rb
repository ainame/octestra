require 'json'
require 'fileutils'
require 'minitest/autorun'
require 'tmpdir'
require_relative '../templates/skills/octestra-setup-migration-epic/scripts/setup_epic'

class FakeGitHubCLI
  attr_reader :calls

  def initialize
    @calls = []
    @next_issue = 100
    @labels = []
  end

  def run(*arguments, input: nil, retries: 3)
    @calls << { type: :run, arguments: arguments, input: input, retries: retries }
    ''
  end

  def json(*arguments, input: nil)
    @calls << { type: :json, arguments: arguments, input: input }
    endpoint = arguments[1]

    return project_workflows if arguments[0..1] == ['api', 'graphql']
    return @labels.map { |name| { 'name' => name } } if endpoint == 'repos/example-org/example-repo/labels?per_page=100'
    return [{ 'id' => 9001, 'name' => 'AI Task Status', 'data_type' => 'single_select' }] if endpoint == '/orgs/example-org/issue-fields'
    if endpoint == 'repos/example-org/example-repo/labels'
      @labels << JSON.parse(input).fetch('name')
      return {}
    end

    if endpoint == 'repos/example-org/example-repo/issues'
      @next_issue += 1
      return {
        'id' => @next_issue * 10,
        'number' => @next_issue,
        'html_url' => "https://github.com/example-org/example-repo/issues/#{@next_issue}"
      }
    end

    raise "Unexpected JSON call: #{arguments.inspect}"
  end

  private

  def project_workflows
    {
      'data' => {
        'organization' => {
          'projectV2' => {
            'workflows' => {
              'nodes' => [
                { 'name' => 'Auto-add sub-issues to project', 'enabled' => true }
              ]
            }
          }
        }
      }
    }
  end
end

class EpicSetupTest < Minitest::Test
  def setup
    @temporary_directories = []
  end

  def teardown
    @temporary_directories.each { |directory| FileUtils.remove_entry(directory) }
  end

  def state_store(value = manifest)
    directory = Dir.mktmpdir('octestra-setup-state-')
    @temporary_directories << directory
    StateStore.new(File.join(directory, 'state.json'), value)
  end

  def manifest
    {
      'repository' => 'example-org/example-repo',
      'project' => { 'owner' => 'example-org', 'number' => 12 },
      'statusField' => 'AI Task Status',
      'epic' => {
        'title' => 'Convert Objective-C to Swift',
        'taskSkill' => 'objc-to-swift',
        'triageSkill' => 'migration-triage',
        'validationSkill' => 'migration-validation',
        'draftPr' => true,
        'skipValidation' => false
      },
      'tasks' => [
        {
          'title' => 'Convert A',
          'target' => 'Sources/A.m'
        },
        {
          'title' => 'Create adapter',
          'target' => nil
        }
      ]
    }
  end

  def test_creates_epic_before_linking_tasks_and_initializes_status
    github = FakeGitHubCLI.new

    result = EpicSetup.new(
      manifest,
      github: github,
      parallel: 2,
      state: state_store
    ).run

    assert_equal 1, result['epics'].length
    assert_equal 2, result['tasksCreated']
    assert_equal 2, result['tasksLinked']
    assert_equal 2, result['statusesInitialized']
    assert_empty result['errors']

    project_call = github.calls.index do |call|
      call[:arguments][0..1] == ['project', 'item-add']
    end
    first_link_call = github.calls.index do |call|
      call[:arguments].any? { |argument| argument.to_s.end_with?('/sub_issues') }
    end
    assert_operator project_call, :<, first_link_call
  end

  def test_generated_task_body_uses_structured_blocks
    github = FakeGitHubCLI.new

    EpicSetup.new(
      manifest,
      github: github,
      parallel: 2,
      state: state_store
    ).run

    issue_payloads = github.calls.filter_map do |call|
      next unless call[:type] == :json
      next unless call[:arguments][1] == 'repos/example-org/example-repo/issues'

      JSON.parse(call[:input])
    end
    task = issue_payloads.find { |payload| payload['title'] == 'Convert A' }
    assert_includes task.fetch('body'), 'target: "Sources/A.m"'
    assert_includes task.fetch('body'), "```task-prompt\n\n```"
    assert_includes task.fetch('body'), "```validation-prompt\n\n```"
    assert_equal ['objc-to-swift'], task.fetch('labels')
  end

  def test_generated_epic_uses_task_skill_as_its_branch_namespace_id
    github = FakeGitHubCLI.new

    EpicSetup.new(
      manifest,
      github: github,
      parallel: 2,
      state: state_store
    ).run

    epic = github.calls.filter_map do |call|
      next unless call[:type] == :json
      next unless call[:arguments][1] == 'repos/example-org/example-repo/issues'

      JSON.parse(call[:input])
    end.find { |payload| payload['labels'] == ['octestra-epic'] }

    assert_includes epic.fetch('body'),
                    "```epic-config\nid: objc-to-swift\ntask_skill: objc-to-swift\n" \
                    "triage_skill: migration-triage\n" \
                    "validation_skill: migration-validation\n" \
                    "draft_pr: true\nskip_validation: false\n```"
    assert_includes epic.fetch('body'), "```epic-task-prompt\n\n```"
    assert_includes epic.fetch('body'), "```epic-triage-prompt\n\n```"
    assert_includes epic.fetch('body'), "```epic-validation-prompt\n\n```"
  end

  def test_requires_validation_skill_when_validation_runs
    invalid = manifest.merge(
      'epic' => manifest.fetch('epic').merge('validationSkill' => nil)
    )

    error = assert_raises(RuntimeError) do
      EpicSetup.new(
        invalid,
        github: FakeGitHubCLI.new,
        parallel: 2,
        state: state_store(invalid)
      )
    end

    assert_equal(
      'epic.validationSkill must be a non-empty string when epic.skipValidation is false',
      error.message
    )
  end

  def test_allows_empty_validation_skill_when_validation_is_skipped
    skipped = manifest.merge(
      'epic' => manifest.fetch('epic').merge(
        'validationSkill' => nil,
        'skipValidation' => true
      )
    )
    github = FakeGitHubCLI.new

    EpicSetup.new(
      skipped,
      github: github,
      parallel: 2,
      state: state_store(skipped)
    ).run

    epic = github.calls.filter_map do |call|
      next unless call[:type] == :json
      next unless call[:arguments][1] == 'repos/example-org/example-repo/issues'

      JSON.parse(call[:input])
    end.find { |payload| payload['labels'] == ['octestra-epic'] }
    assert_includes epic.fetch('body'), "validation_skill: \ndraft_pr: true\nskip_validation: true"
  end

  def test_rejects_an_empty_task_list
    invalid = manifest.merge('tasks' => [])

    error = assert_raises(RuntimeError) do
      EpicSetup.new(
        invalid,
        github: FakeGitHubCLI.new,
        parallel: 2,
        state: state_store(invalid)
      )
    end

    assert_equal 'tasks must be a non-empty array', error.message
  end

  def test_splits_tasks_across_epics_at_the_hundred_task_boundary
    github = FakeGitHubCLI.new
    tasks = Array.new(101) do |index|
      { 'title' => "Task #{index + 1}", 'target' => nil, 'taskPrompt' => '' }
    end

    result = EpicSetup.new(
      manifest.merge('tasks' => tasks),
      github: github,
      parallel: 8,
      state: state_store(manifest.merge('tasks' => tasks))
    ).run

    assert_equal 2, result['epics'].length
    link_calls = github.calls.select do |call|
      call[:arguments].any? { |argument| argument.to_s.end_with?('/sub_issues') }
    end
    assert_equal 100, link_calls.count { |call|
      call[:arguments].include?('repos/example-org/example-repo/issues/101/sub_issues')
    }
    assert_equal 1, link_calls.count { |call|
      call[:arguments].include?('repos/example-org/example-repo/issues/102/sub_issues')
    }
  end

  def test_resumes_without_repeating_completed_writes
    github = FakeGitHubCLI.new
    state = state_store

    EpicSetup.new(manifest, github: github, parallel: 2, state: state).run
    writes_after_first_run = write_calls(github).length

    result = EpicSetup.new(
      manifest,
      github: github,
      parallel: 2,
      state: StateStore.new(state.path, manifest)
    ).run

    assert result['resumed']
    assert_equal writes_after_first_run, write_calls(github).length
    assert_equal 2, result['statusesInitialized']
  end

  def test_rejects_resume_when_the_manifest_changed
    state = state_store
    changed = manifest.merge(
      'epic' => manifest.fetch('epic').merge('title' => 'Different migration')
    )

    error = assert_raises(RuntimeError) { StateStore.new(state.path, changed) }

    assert_includes error.message, 'Manifest does not match state file'
  end

  private

  def write_calls(github)
    github.calls.select do |call|
      arguments = call[:arguments]
      arguments.include?('POST') || arguments[0..1] == ['project', 'item-add']
    end
  end
end
