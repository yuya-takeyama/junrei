import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFilesystemDiskContextProvider,
  createFilesystemTemplateProvider,
  resolveTemplatesDir,
} from "./reconstruction.js";

describe("resolveTemplatesDir", () => {
  it("uses JUNREI_TEMPLATES_DIR when set", () => {
    expect(resolveTemplatesDir({ JUNREI_TEMPLATES_DIR: "/tmp/custom-templates" })).toBe(
      "/tmp/custom-templates",
    );
  });

  it("falls back to ~/.junrei/templates when unset", () => {
    const resolved = resolveTemplatesDir({});
    expect(resolved.endsWith(join(".junrei", "templates"))).toBe(true);
  });

  it("falls back when the env var is blank", () => {
    const resolved = resolveTemplatesDir({ JUNREI_TEMPLATES_DIR: "   " });
    expect(resolved.endsWith(join(".junrei", "templates"))).toBe(true);
  });
});

describe("createFilesystemTemplateProvider", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "junrei-recon-template-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const validTemplate = {
    cliVersion: "2.1.205",
    capturedValues: {
      cwd: "/synthetic/project",
      sessionId: "11111111-1111-1111-1111-111111111111",
    },
    system: [
      { text: "You are a synthetic identity block." },
      {
        text: "Synthetic instructions for /synthetic/project, session 11111111-1111-1111-1111-111111111111.",
      },
    ],
    tools: [{ name: "Read", description: "synthetic", input_schema: { type: "object" } }],
    params: { max_tokens: 1024, stream: true },
  };

  it("reads and validates a template.json", async () => {
    await mkdir(join(root, "2.1.205"), { recursive: true });
    await writeFile(join(root, "2.1.205", "template.json"), JSON.stringify(validTemplate));

    const provider = createFilesystemTemplateProvider({ templatesDir: root });
    const template = await provider.getTemplate("2.1.205");

    expect(template?.cliVersion).toBe("2.1.205");
    expect(template?.system).toHaveLength(2);
    expect(template?.tools).toHaveLength(1);
    expect(template?.params).toEqual({ max_tokens: 1024, stream: true });
  });

  it("returns undefined for a missing cliVersion dir", async () => {
    const provider = createFilesystemTemplateProvider({ templatesDir: root });
    expect(await provider.getTemplate("9.9.9")).toBeUndefined();
  });

  it("returns undefined for malformed JSON", async () => {
    await mkdir(join(root, "2.1.205"), { recursive: true });
    await writeFile(join(root, "2.1.205", "template.json"), "{not valid json");

    const provider = createFilesystemTemplateProvider({ templatesDir: root });
    expect(await provider.getTemplate("2.1.205")).toBeUndefined();
  });

  it("returns undefined for a well-formed JSON file that fails template validation", async () => {
    await mkdir(join(root, "2.1.205"), { recursive: true });
    await writeFile(
      join(root, "2.1.205", "template.json"),
      JSON.stringify({ cliVersion: "2.1.205" }),
    );

    const provider = createFilesystemTemplateProvider({ templatesDir: root });
    expect(await provider.getTemplate("2.1.205")).toBeUndefined();
  });
});

describe("createFilesystemDiskContextProvider", () => {
  let root: string;
  let projectsDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "junrei-recon-disk-"));
    projectsDir = join(root, "claude-home", "projects");
    await mkdir(projectsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function accountFile(email: string | undefined): Promise<string> {
    const path = join(root, "claude.json");
    await writeFile(
      path,
      JSON.stringify(email === undefined ? {} : { oauthAccount: { emailAddress: email } }),
    );
    return path;
  }

  it("reads global CLAUDE.md, project CLAUDE.md, memory, and email", async () => {
    await writeFile(join(root, "claude-home", "CLAUDE.md"), "# global synthetic instructions\n");
    const projectDirName = "-synthetic-project";
    await mkdir(join(projectsDir, projectDirName, "memory"), { recursive: true });
    await writeFile(
      join(projectsDir, projectDirName, "memory", "MEMORY.md"),
      "# synthetic memory\n",
    );
    const cwd = await mkdtemp(join(tmpdir(), "junrei-recon-cwd-"));
    await writeFile(join(cwd, "CLAUDE.md"), "# project synthetic instructions\n");
    const accountPath = await accountFile("synthetic@example.com");

    const provider = createFilesystemDiskContextProvider({
      projectDirName,
      resolveProjectsDirs: async () => [projectsDir],
      accountFilePath: accountPath,
    });

    const ctx = await provider.getDiskContext({ sessionId: "s1", cwd });

    expect(ctx?.globalClaudeMd?.content).toBe("# global synthetic instructions\n");
    expect(ctx?.globalClaudeMd?.mtimeMs).toBeGreaterThan(0);
    expect(ctx?.projectClaudeMd?.content).toBe("# project synthetic instructions\n");
    expect(ctx?.memoryMd?.content).toBe("# synthetic memory\n");
    expect(ctx?.email).toBe("synthetic@example.com");
    expect(ctx?.emailMtimeMs).toBeGreaterThan(0);

    await rm(cwd, { recursive: true, force: true });
  });

  it("degrades gracefully when global CLAUDE.md is absent", async () => {
    const accountPath = await accountFile("synthetic@example.com");
    const provider = createFilesystemDiskContextProvider({
      resolveProjectsDirs: async () => [projectsDir],
      accountFilePath: accountPath,
    });

    const ctx = await provider.getDiskContext({ sessionId: "s1" });

    expect(ctx?.globalClaudeMd).toBeUndefined();
    expect(ctx?.email).toBe("synthetic@example.com");
  });

  it("leaves memoryMd absent when projectDirName is not given", async () => {
    await writeFile(join(root, "claude-home", "CLAUDE.md"), "# global\n");
    const provider = createFilesystemDiskContextProvider({
      resolveProjectsDirs: async () => [projectsDir],
      accountFilePath: await accountFile("synthetic@example.com"),
    });

    const ctx = await provider.getDiskContext({ sessionId: "s1" });

    expect(ctx?.memoryMd).toBeUndefined();
    expect(ctx?.globalClaudeMd?.content).toBe("# global\n");
  });

  it("leaves email absent when the account file has no oauthAccount", async () => {
    const provider = createFilesystemDiskContextProvider({
      resolveProjectsDirs: async () => [projectsDir],
      accountFilePath: await accountFile(undefined),
    });

    const ctx = await provider.getDiskContext({ sessionId: "s1" });

    expect(ctx?.email).toBeUndefined();
    expect(ctx?.emailMtimeMs).toBeUndefined();
  });

  it("leaves email absent when the account file doesn't exist", async () => {
    const provider = createFilesystemDiskContextProvider({
      resolveProjectsDirs: async () => [projectsDir],
      accountFilePath: join(root, "does-not-exist.json"),
    });

    const ctx = await provider.getDiskContext({ sessionId: "s1" });

    expect(ctx?.email).toBeUndefined();
  });

  it("picks the candidate projects dir that actually contains the project dir, across multiple CLAUDE_CONFIG_DIR entries", async () => {
    const otherProjectsDir = join(root, "other-claude-home", "projects");
    await mkdir(otherProjectsDir, { recursive: true });
    await writeFile(join(root, "other-claude-home", "CLAUDE.md"), "# wrong global\n");
    await writeFile(join(root, "claude-home", "CLAUDE.md"), "# right global\n");
    const projectDirName = "-synthetic-project";
    await mkdir(join(projectsDir, projectDirName), { recursive: true });

    const provider = createFilesystemDiskContextProvider({
      projectDirName,
      // The "wrong" candidate is listed FIRST — the provider must still pick
      // the one that actually contains this project's dir, not just the first.
      resolveProjectsDirs: async () => [otherProjectsDir, projectsDir],
      accountFilePath: join(root, "does-not-exist.json"),
    });

    const ctx = await provider.getDiskContext({ sessionId: "s1" });

    expect(ctx?.globalClaudeMd?.content).toBe("# right global\n");
  });

  it("never throws and returns an empty-ish context when nothing resolves", async () => {
    const provider = createFilesystemDiskContextProvider({
      resolveProjectsDirs: async () => [],
      accountFilePath: join(root, "does-not-exist.json"),
    });

    const ctx = await provider.getDiskContext({ sessionId: "s1" });

    expect(ctx?.globalClaudeMd).toBeUndefined();
    expect(ctx?.projectClaudeMd).toBeUndefined();
    expect(ctx?.memoryMd).toBeUndefined();
    expect(ctx?.email).toBeUndefined();
  });
});
