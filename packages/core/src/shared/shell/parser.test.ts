import { describe, expect, it } from "vitest";
import { parseShellCommand, primaryCommand } from "./parser.js";

describe("parseShellCommand", () => {
  it("returns no segments for an empty or whitespace-only command", () => {
    expect(parseShellCommand("")).toEqual({ segments: [] });
    expect(parseShellCommand("   ")).toEqual({ segments: [] });
  });

  it("parses a bare command with no args", () => {
    const parsed = parseShellCommand("pwd");
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]).toEqual({
      raw: "pwd",
      envAssignments: [],
      executable: "pwd",
      args: [],
    });
  });

  it("collects simple args", () => {
    const [seg] = parseShellCommand("ls -la /tmp").segments;
    expect(seg?.executable).toBe("ls");
    expect(seg?.args).toEqual(["-la", "/tmp"]);
  });

  describe("segment splitting", () => {
    it("splits on pipe", () => {
      const parsed = parseShellCommand("git diff | grep foo");
      expect(parsed.segments).toHaveLength(2);
      expect(parsed.segments[0]?.executable).toBe("git");
      expect(parsed.segments[1]?.executable).toBe("grep");
    });

    it("splits on && and ||", () => {
      const parsed = parseShellCommand("cd /foo && pnpm test || echo failed");
      expect(parsed.segments.map((s) => s.executable)).toEqual(["cd", "pnpm", "echo"]);
    });

    it("splits on ;", () => {
      const parsed = parseShellCommand("echo a; echo b; echo c");
      expect(parsed.segments).toHaveLength(3);
      expect(parsed.segments.map((s) => s.raw)).toEqual(["echo a", "echo b", "echo c"]);
    });

    it("splits without surrounding whitespace", () => {
      const parsed = parseShellCommand("true&&false||echo x;echo y");
      expect(parsed.segments.map((s) => s.executable)).toEqual(["true", "false", "echo", "echo"]);
    });

    it("distinguishes | from ||", () => {
      expect(parseShellCommand("a | b").segments).toHaveLength(2);
      expect(parseShellCommand("a || b").segments).toHaveLength(2);
      expect(parseShellCommand("a || b").segments[0]?.raw).toBe("a");
    });
  });

  describe("quoting and escaping", () => {
    it("never splits inside single quotes", () => {
      const parsed = parseShellCommand("echo 'a | b; c && d'");
      expect(parsed.segments).toHaveLength(1);
      expect(parsed.segments[0]?.args).toEqual(["a | b; c && d"]);
    });

    it("never splits inside double quotes", () => {
      const parsed = parseShellCommand('git commit -m "fix: a | b; c"');
      expect(parsed.segments).toHaveLength(1);
      expect(parsed.segments[0]?.args).toEqual(["commit", "-m", "fix: a | b; c"]);
      expect(parsed.segments[0]?.subcommand).toBe("commit");
    });

    it("strips quote characters from the token value", () => {
      const [seg] = parseShellCommand('echo "hello world"').segments;
      expect(seg?.args).toEqual(["hello world"]);
    });

    it("preserves single-quoted content literally, incl. double quotes inside", () => {
      const [seg] = parseShellCommand(`echo 'it said "hi"'`).segments;
      expect(seg?.args).toEqual(['it said "hi"']);
    });

    it('resolves \\" and other double-quote escapes but keeps unrecognized backslashes literal', () => {
      const [seg] = parseShellCommand('echo "a \\"quoted\\" b \\n c"').segments;
      // \" -> ", but \n (not in the escapable set) keeps its backslash.
      expect(seg?.args).toEqual(['a "quoted" b \\n c']);
    });

    it("honors a backslash-escaped space outside quotes as part of one word", () => {
      const [seg] = parseShellCommand("echo foo\\ bar").segments;
      expect(seg?.args).toEqual(["foo bar"]);
    });

    it("honors a backslash-escaped pipe outside quotes as a literal character, not an operator", () => {
      const parsed = parseShellCommand("echo a\\|b");
      expect(parsed.segments).toHaveLength(1);
      expect(parsed.segments[0]?.args).toEqual(["a|b"]);
    });

    it("collects an env assignment with a quoted value containing spaces", () => {
      const [seg] = parseShellCommand('FOO="bar baz" node script.js').segments;
      expect(seg?.envAssignments).toEqual(["FOO=bar baz"]);
      expect(seg?.executable).toBe("node");
    });

    it("tolerates an unterminated quote without throwing", () => {
      expect(() => parseShellCommand("echo 'unterminated")).not.toThrow();
      expect(() => parseShellCommand('echo "unterminated')).not.toThrow();
    });
  });

  describe("redirects", () => {
    it("strips a simple output redirect and its filename target, keeping the real arg", () => {
      const [seg] = parseShellCommand("pnpm test > out.txt").segments;
      expect(seg?.args).toEqual(["test"]);
    });

    it("strips >> and its target", () => {
      const [seg] = parseShellCommand("pnpm test >> out.txt").segments;
      expect(seg?.args).toEqual(["test"]);
    });

    it("strips a numbered redirect (2>) and its target", () => {
      const [seg] = parseShellCommand("pnpm test 2> err.txt").segments;
      expect(seg?.args).toEqual(["test"]);
    });

    it("strips a self-contained fd-dup redirect (2>&1) without eating the next real arg", () => {
      const [seg] = parseShellCommand("pnpm test > out.txt 2>&1").segments;
      expect(seg?.args).toEqual(["test"]);
    });

    it("keeps real args alongside a stripped redirect", () => {
      const [seg] = parseShellCommand("pnpm test --coverage > out.txt").segments;
      expect(seg?.args).toEqual(["test", "--coverage"]);
    });

    it("strips a bare redirect with no other args down to empty", () => {
      const [seg] = parseShellCommand("true > out.txt 2>&1").segments;
      expect(seg?.executable).toBe("true");
      expect(seg?.args).toEqual([]);
    });

    it("does not confuse a bare & in 2>&1 for the && operator", () => {
      const parsed = parseShellCommand("pnpm test > out.txt 2>&1 && echo done");
      expect(parsed.segments).toHaveLength(2);
      expect(parsed.segments[1]?.executable).toBe("echo");
    });

    describe("attached (no-space) forms", () => {
      it("strips a redirect glued directly onto the preceding arg", () => {
        const [seg] = parseShellCommand("pnpm test>out.txt").segments;
        expect(seg?.executable).toBe("pnpm");
        expect(seg?.args).toEqual(["test"]);
        expect(seg?.hasOutputRedirect).toBe(true);
      });

      it("strips a whole-token attached numbered redirect (2>out.txt), but does not set hasOutputRedirect — fd 2 is stderr, not stdout", () => {
        const [seg] = parseShellCommand("pnpm test 2>out.txt").segments;
        expect(seg?.args).toEqual(["test"]);
        expect(seg?.hasOutputRedirect).toBeUndefined();
      });

      it("strips a whole-token attached &> redirect", () => {
        const [seg] = parseShellCommand("pnpm test &>out.txt").segments;
        expect(seg?.args).toEqual(["test"]);
        expect(seg?.hasOutputRedirect).toBe(true);
      });

      it("splits an attached redirect off a non-family command's file arg", () => {
        const [seg] = parseShellCommand("cat foo.log>out.txt").segments;
        expect(seg?.executable).toBe("cat");
        expect(seg?.args).toEqual(["foo.log"]);
        expect(seg?.hasOutputRedirect).toBe(true);
      });

      it("does not split a > that only exists inside quoted text", () => {
        const [seg] = parseShellCommand('echo "a>b"').segments;
        expect(seg?.executable).toBe("echo");
        expect(seg?.args).toEqual(["a>b"]);
        expect(seg?.hasOutputRedirect).toBeUndefined();
      });

      it("does not set hasOutputRedirect for a plain command with no redirect", () => {
        const [seg] = parseShellCommand("pnpm test").segments;
        expect(seg?.hasOutputRedirect).toBeUndefined();
      });

      it("does not treat a bare fd-dup redirect (2>&1) as an output redirect", () => {
        const [seg] = parseShellCommand("pnpm test 2>&1").segments;
        expect(seg?.args).toEqual(["test"]);
        expect(seg?.hasOutputRedirect).toBeUndefined();
      });

      it("does not treat an attached fd-dup redirect (echo hi>&2) as an output redirect", () => {
        const [seg] = parseShellCommand("echo hi>&2").segments;
        expect(seg?.args).toEqual(["hi"]);
        expect(seg?.hasOutputRedirect).toBeUndefined();
      });

      it("distinguishes a word ending in a digit (foo2>out) from a pure fd redirect (2>out)", () => {
        const withWord = parseShellCommand("touch foo2>out").segments[0];
        expect(withWord?.args).toEqual(["foo2"]);
        expect(withWord?.hasOutputRedirect).toBe(true);

        const pureFd = parseShellCommand("touch 2>out").segments[0];
        expect(pureFd?.args).toEqual([]);
        expect(pureFd?.hasOutputRedirect).toBeUndefined();
      });
    });

    describe("hasOutputRedirect: stdout-only semantics", () => {
      it.each([
        ["cmd 2>err.txt", false],
        ["cmd 2>>err.txt", false],
        ["cmd >out.txt", true],
        ["cmd >>out.txt", true],
        ["cmd 1>out.txt", true],
        ["cmd 1>>out.txt", true],
        ["cmd &>all.txt", true],
        ["cmd &>>all.txt", true],
        ["cmd 2>&1", false],
        ["cmd >&2", false],
        ["cmd 1>&2", false],
      ] as const)("%s -> hasOutputRedirect %s", (command, expected) => {
        const [seg] = parseShellCommand(command).segments;
        expect(seg?.hasOutputRedirect === true).toBe(expected);
      });
    });

    describe("not mangled by the redirect scanner", () => {
      it("keeps both process-substitution operands intact as args", () => {
        const [seg] = parseShellCommand("diff <(sort a) <(sort b)").segments;
        expect(seg?.executable).toBe("diff");
        expect(seg?.args).toEqual(["<(sort a)", "<(sort b)"]);
        expect(seg?.hasOutputRedirect).toBeUndefined();
      });

      it("keeps a >(...) process substitution (with a nested > inside it) intact as one arg", () => {
        const [seg] = parseShellCommand("tee >(gzip > out.gz)").segments;
        expect(seg?.executable).toBe("tee");
        expect(seg?.args).toEqual([">(gzip > out.gz)"]);
        expect(seg?.hasOutputRedirect).toBeUndefined();
      });

      it("does not set hasOutputRedirect for a heredoc (<<EOF)", () => {
        const [seg] = parseShellCommand("cat <<EOF").segments;
        expect(seg?.executable).toBe("cat");
        expect(seg?.hasOutputRedirect).toBeUndefined();
      });

      it('does not set hasOutputRedirect for a here-string (<<<"x")', () => {
        const [seg] = parseShellCommand('cat <<<"x"').segments;
        expect(seg?.executable).toBe("cat");
        expect(seg?.hasOutputRedirect).toBeUndefined();
      });
    });

    describe("attached-value flags", () => {
      it("keeps a head -n100 attached-value flag as one token, separate from the file arg", () => {
        const [seg] = parseShellCommand("head -n100 file").segments;
        expect(seg?.executable).toBe("head");
        expect(seg?.args).toEqual(["-n100", "file"]);
        expect(seg?.hasOutputRedirect).toBeUndefined();
      });

      it("keeps a head -c4K attached-value flag as one token, separate from the file arg", () => {
        const [seg] = parseShellCommand("head -c4K file").segments;
        expect(seg?.executable).toBe("head");
        expect(seg?.args).toEqual(["-c4K", "file"]);
        expect(seg?.hasOutputRedirect).toBeUndefined();
      });
    });
  });

  describe("command substitution and backticks", () => {
    it("keeps a $() span intact and does not split on ; inside it", () => {
      const parsed = parseShellCommand('echo "Result: $(pnpm test; echo done)"');
      expect(parsed.segments).toHaveLength(1);
      expect(parsed.segments[0]?.executable).toBe("echo");
      expect(parsed.segments[0]?.args?.[0]).toContain("$(pnpm test; echo done)");
    });

    it("keeps a nested $(...) span balanced", () => {
      const parsed = parseShellCommand('echo "$(echo $(echo inner))"');
      expect(parsed.segments).toHaveLength(1);
      expect(parsed.segments[0]?.args?.[0]).toBe("$(echo $(echo inner))");
    });

    it("keeps a backtick span intact and does not split inside it", () => {
      const parsed = parseShellCommand("echo `pnpm test; echo done`");
      expect(parsed.segments).toHaveLength(1);
      expect(parsed.segments[0]?.args?.[0]).toContain("pnpm test; echo done");
    });

    it("keeps the outer executable when a bare $() substitution follows it", () => {
      const parsed = parseShellCommand("echo $(date +%s)");
      expect(parsed.segments).toHaveLength(1);
      expect(parsed.segments[0]?.executable).toBe("echo");
    });
  });

  describe("wrapper commands", () => {
    it("skips env and its assignments to find the wrapped executable", () => {
      const [seg] = parseShellCommand("env FOO=bar node script.js").segments;
      expect(seg?.executable).toBe("node");
      expect(seg?.envAssignments).toEqual(["FOO=bar"]);
      expect(seg?.args).toEqual(["script.js"]);
    });

    it("skips time to find the wrapped executable", () => {
      const [seg] = parseShellCommand("time pnpm test").segments;
      expect(seg?.executable).toBe("pnpm");
      expect(seg?.subcommand).toBe("test");
    });

    it("skips nice and its detached -n value", () => {
      const [seg] = parseShellCommand("nice -n 10 make build").segments;
      expect(seg?.executable).toBe("make");
      expect(seg?.args).toEqual(["build"]);
    });

    it("skips command", () => {
      const [seg] = parseShellCommand("command ls -la").segments;
      expect(seg?.executable).toBe("ls");
      expect(seg?.args).toEqual(["-la"]);
    });

    it("skips xargs with no flags", () => {
      const [seg] = parseShellCommand("xargs grep foo").segments;
      expect(seg?.executable).toBe("grep");
      expect(seg?.args).toEqual(["foo"]);
    });

    it("skips xargs's attached-value flags", () => {
      const [seg] = parseShellCommand("xargs -I{} rm {}").segments;
      expect(seg?.executable).toBe("rm");
      expect(seg?.args).toEqual(["{}"]);
    });

    it("skips xargs's detached-value flags", () => {
      const [seg] = parseShellCommand("xargs -n 1 -P 4 echo").segments;
      expect(seg?.executable).toBe("echo");
    });

    it("unwraps nested wrappers", () => {
      const [seg] = parseShellCommand("time env FOO=bar nice -n5 make").segments;
      expect(seg?.executable).toBe("make");
      expect(seg?.envAssignments).toEqual(["FOO=bar"]);
    });

    it("leaves executable undefined for a wrapper with nothing after it", () => {
      const [seg] = parseShellCommand("env").segments;
      expect(seg?.executable).toBeUndefined();
    });
  });

  describe("subcommand extraction for known families", () => {
    it.each([
      ["git diff --stat", "git", "diff"],
      // Known limitation: value-consuming global flags aren't special-cased,
      // so the flag's OWN value is misidentified as the subcommand here.
      ["git -c advice.foo=false status", "git", "advice.foo=false"],
      ["gh pr view 123", "gh", "pr"],
      ["pnpm run build", "pnpm", "run"],
      ["npm install foo", "npm", "install"],
      ["npx vitest run", "npx", "vitest"],
      ["yarn add left-pad", "yarn", "add"],
      ["cargo build --release", "cargo", "build"],
      ["go test ./...", "go", "test"],
      ["docker compose up", "docker", "compose"],
      ["kubectl get pods", "kubectl", "get"],
      ["aqua install", "aqua", "install"],
      ["corepack pnpm install", "corepack", "pnpm"],
    ])("%s -> %s/%s", (command, executable, subcommand) => {
      const [seg] = parseShellCommand(command).segments;
      expect(seg?.executable).toBe(executable);
      expect(seg?.subcommand).toBe(subcommand);
    });

    it("does not extract a subcommand for an unknown family", () => {
      const [seg] = parseShellCommand("node script.js run").segments;
      expect(seg?.executable).toBe("node");
      expect(seg?.subcommand).toBeUndefined();
    });

    it("leaves subcommand undefined when every arg is a flag", () => {
      const [seg] = parseShellCommand("git --version").segments;
      expect(seg?.executable).toBe("git");
      expect(seg?.subcommand).toBeUndefined();
    });

    it("leaves subcommand undefined when there are no args at all", () => {
      const [seg] = parseShellCommand("git").segments;
      expect(seg?.subcommand).toBeUndefined();
    });
  });

  describe("control keywords", () => {
    it.each([
      "for",
      "while",
      "if",
      "until",
      "case",
      "select",
    ])("classifies a %s-led segment via controlKeyword, not executable", (keyword) => {
      const [seg] = parseShellCommand(`${keyword} something here`).segments;
      expect(seg?.controlKeyword).toBe(keyword);
      expect(seg?.executable).toBeUndefined();
    });

    it("classifies the continuation keywords produced by naive ;-splitting a for-loop", () => {
      const parsed = parseShellCommand("for f in *.txt; do echo $f; done");
      const keywords = parsed.segments.map((s) => s.controlKeyword);
      expect(keywords).toEqual(["for", "do", "done"]);
    });

    it("classifies an if/then/fi chain's segments", () => {
      const parsed = parseShellCommand("if true; then echo hi; fi");
      expect(parsed.segments.map((s) => s.controlKeyword)).toEqual(["if", "then", "fi"]);
    });
  });

  describe("env-assignment-only and malformed segments", () => {
    it("leaves executable undefined for a bare env assignment with nothing after it", () => {
      const [seg] = parseShellCommand("FOO=bar").segments;
      expect(seg?.executable).toBeUndefined();
      expect(seg?.envAssignments).toEqual(["FOO=bar"]);
    });

    it("collects multiple leading env assignments", () => {
      const [seg] = parseShellCommand("FOO=bar BAZ=qux node script.js").segments;
      expect(seg?.envAssignments).toEqual(["FOO=bar", "BAZ=qux"]);
      expect(seg?.executable).toBe("node");
    });

    it("produces an empty segment for a trailing separator without throwing", () => {
      const parsed = parseShellCommand("echo hi;");
      expect(parsed.segments).toHaveLength(2);
      expect(parsed.segments[1]).toEqual({ raw: "", envAssignments: [], args: [] });
    });
  });
});

describe("primaryCommand", () => {
  it("returns the single segment for a plain command", () => {
    const parsed = parseShellCommand("pnpm test");
    expect(primaryCommand(parsed)?.executable).toBe("pnpm");
  });

  it("skips a leading cd segment", () => {
    const parsed = parseShellCommand("cd /repo && pnpm test");
    expect(primaryCommand(parsed)?.executable).toBe("pnpm");
  });

  it("returns the first meaningful segment of a pipeline", () => {
    const parsed = parseShellCommand("git diff | grep foo");
    expect(primaryCommand(parsed)?.executable).toBe("git");
  });

  it("returns undefined for a bare env assignment with nothing after it", () => {
    const parsed = parseShellCommand("FOO=bar");
    expect(primaryCommand(parsed)).toBeUndefined();
  });

  it("returns undefined for cd alone", () => {
    const parsed = parseShellCommand("cd /repo");
    expect(primaryCommand(parsed)).toBeUndefined();
  });

  it("skips past a pure wrapper with nothing after it to find the next real segment", () => {
    const parsed = parseShellCommand("env && pnpm test");
    expect(primaryCommand(parsed)?.executable).toBe("pnpm");
  });

  it("unwraps a wrapper command to attribute to the wrapped executable", () => {
    const parsed = parseShellCommand("cd /repo && time pnpm test");
    expect(primaryCommand(parsed)?.executable).toBe("pnpm");
  });

  describe("near-zero-output skipping", () => {
    it("skips a chained cd and echo to attribute a sequential chain to the real command", () => {
      const parsed = parseShellCommand('cd X; echo "==="; cat -n f');
      expect(primaryCommand(parsed)?.executable).toBe("cat");
    });

    it("skips a leading echo in a pipeline to attribute to the real command", () => {
      const parsed = parseShellCommand('echo "$x" | jq .');
      expect(primaryCommand(parsed)?.executable).toBe("jq");
    });

    it("falls back to the trivial command itself when nothing else qualifies", () => {
      const parsed = parseShellCommand("echo hi");
      expect(primaryCommand(parsed)?.executable).toBe("echo");
    });

    it("returns undefined for cd alone (no fallback segment qualifies either)", () => {
      const parsed = parseShellCommand("cd /foo");
      expect(primaryCommand(parsed)).toBeUndefined();
    });

    it("still picks the first real command when two non-trivial commands are chained", () => {
      const parsed = parseShellCommand("git fetch && git rebase");
      expect(primaryCommand(parsed)?.executable).toBe("git");
      expect(primaryCommand(parsed)?.subcommand).toBe("fetch");
    });

    it("skips a trailing echo status-print after a real command", () => {
      const parsed = parseShellCommand("pnpm test; echo EXIT=$?");
      expect(primaryCommand(parsed)?.executable).toBe("pnpm");
    });
  });
});
