// Branch names are rendered from a consumer-supplied template, so the same two
// failure modes apply everywhere: a template that omits a placeholder silently
// collides across runs, and a substituted value can produce a name Git rejects.
// Both checks live here so lifecycle and loop templates cannot drift apart.
export function renderBranchTemplate(
  template: string,
  replacements: Record<string, string>,
  missingPlaceholderMessage: string,
): string {
  for (const placeholder of Object.keys(replacements)) {
    if (!template.includes(`{${placeholder}}`)) {
      throw new Error(missingPlaceholderMessage);
    }
  }

  let branchName = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    branchName = branchName.replaceAll(`{${placeholder}}`, value);
  }

  if (
    !branchName ||
    branchName.includes("..") ||
    branchName.startsWith("/") ||
    branchName.endsWith("/")
  ) {
    throw new Error(`branch template resolved to an invalid branch name: ${branchName}`);
  }
  return branchName;
}
