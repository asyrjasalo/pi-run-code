# pi-run-code

Pi CLI extension that adds a `run_code` tool for executing TypeScript/JavaScript code. Does not replace or disable existing Pi tools.

## Install

`pi install git:github.com/asyrjasalo/pi-run-code`

## Security

By default, `run_code` executes code inside a **secure-exec V8 isolate sandbox**:

- ✅ **Filesystem** — read/write via `require("fs")` (real host files)
- ✅ **Network** — `fetch()` and `require("http")` work
- ✅ **Shell** — `$` shim via `child_process` (`await $\`echo hi\``)
- ✅ **Packages** — `require()` resolves from host `node_modules`
- ✅ **Env** — `process.env` available
- ✅ **Return values** — `return expr` works

Safety comes from the **V8 isolate boundary** + resource limits:

- Separate heap/stack (cannot corrupt host process memory)
- Memory limit: 128 MB per execution
- CPU time limit: 15 s per execution
- Cannot escape the V8 isolate

### Unsandboxed (legacy) mode

For native zx `$` (full ProcessPromise API) and direct host globals, set `PI_RUN_CODE_UNSANDBOXED` before starting Pi:

```sh
export PI_RUN_CODE_UNSANDBOXED=1
```

> ⚠️ **Warning**: Unsandboxed mode runs code via `AsyncFunction` in the host process with no isolation.

## Usage

In Pi, say "run code" followed by what you want executed:

```
> run code list files in this dir
> run code compute fibonacci(20)
> run code parse this YAML
```

The agent will call `run_code` with TS/JS code. Available inside code:

- `$` (zx shell) - run shell commands: `` const out = await $`ls` ``
- `print(...)` - output to include in result
- `console.log/warn/error` - captured output
- `require(...)` - import any Node.js module (fs, path, os, etc.)

Only TypeScript and JavaScript syntax is accepted.

## Packages

Configure npm packages in `.pi/pi-run-code.json` (project) or `~/.pi/agent/pi-run-code.json` (global). Packages are auto-installed and injected as globals.

```json
{
  "packages": {
    "yaml": { "version": "^2", "as": "YAML" },
    "humanize-duration": "*"
  }
}
```

String shorthand (`"*"`, `"^4"`) auto-generates variable names: `humanize-duration` → `humanizeDuration`, `@scope/foo-bar` → `fooBar`.

Object form supports custom variable name and description:

```json
{
  "packages": {
    "yaml": {
      "version": "^2",
      "as": "YAML",
      "description": "YAML parser and stringifier"
    }
  }
}
```

Packages install to `.pi/pi-run-code/node_modules/` (project) or `~/.pi/agent/pi-run-code/node_modules/` (global). The directory is auto-added to `.pi/.gitignore`.

Project config overrides global for same variable name. Installs are skipped if `package.json` hasn't changed.

## Test

```
npm test
```

## License

MIT
