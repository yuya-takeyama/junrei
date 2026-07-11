require "yaml"

paths = Dir[".claude/skills/*/SKILL.md"]
abort "No skills found under .claude/skills" if paths.empty?

paths.each do |path|
  frontmatter = File.read(path)[/\A---\s*\n(.*?)^---\s*$/m, 1]
  abort "#{path}: missing YAML frontmatter" if frontmatter.nil?

  data = YAML.safe_load(frontmatter, permitted_classes: [], aliases: false)
  abort "#{path}: missing name" unless data.is_a?(Hash) && data["name"].is_a?(String) && !data["name"].empty?
  abort "#{path}: missing description" unless data.is_a?(Hash) && data["description"].is_a?(String) && !data["description"].empty?
end

puts "Validated #{paths.length} skill frontmatter file(s)."
