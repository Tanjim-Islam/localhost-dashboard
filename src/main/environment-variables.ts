import { spawn } from "node:child_process";
import * as path from "node:path";

// Windows-only persistence service for credential-like user and machine variables.

export type EnvironmentVariableScope = "user" | "machine";
export type EnvironmentVariableSessionStatus =
  "active" | "restart-required" | "shadowed";

export type EnvironmentVariableSummary = {
  id: string;
  name: string;
  scope: EnvironmentVariableScope;
  valueLength: number;
  sessionStatus: EnvironmentVariableSessionStatus;
};

export type EnvironmentVariableRef = {
  name: string;
  scope: EnvironmentVariableScope;
};

export type SaveEnvironmentVariableInput = EnvironmentVariableRef & {
  value: string;
  original?: EnvironmentVariableRef;
};

type PowerShellListItem = {
  name: unknown;
  scope: unknown;
  valueLength: unknown;
  sessionStatus: unknown;
};

type PowerShellResponse<T> =
  { ok: true; result: T } | { ok: false; message?: string };

const MAX_NAME_LENGTH = 128;
const MAX_VALUE_LENGTH = 8192;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_NAME_PARTS = new Set([
  "KEY",
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PWD",
  "CREDENTIAL",
  "CREDENTIALS",
  "PAT",
]);

const POWERSHELL_PREFIX = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
function Write-JsonResult($Value) {
  [Console]::Out.Write(($Value | ConvertTo-Json -Depth 8 -Compress))
}
function Get-Target([string]$Scope) {
  if ($Scope -eq 'user') {
    return [System.EnvironmentVariableTarget]::User
  }
  if ($Scope -eq 'machine') {
    return [System.EnvironmentVariableTarget]::Machine
  }
  throw 'Environment variable scope must be user or machine.'
}
`;

const LIST_SCRIPT = `${POWERSHELL_PREFIX}
try {
  $items = @()
  $targets = @(
    @{ scope = 'user'; target = [System.EnvironmentVariableTarget]::User },
    @{ scope = 'machine'; target = [System.EnvironmentVariableTarget]::Machine }
  )

  foreach ($entry in $targets) {
    $variables = [System.Environment]::GetEnvironmentVariables($entry.target)
    foreach ($nameValue in $variables.GetEnumerator()) {
      $name = [string]$nameValue.Key
      $storedValue = [string]$nameValue.Value
      $processValue = [System.Environment]::GetEnvironmentVariable(
        $name,
        [System.EnvironmentVariableTarget]::Process
      )
      $sessionStatus = 'restart-required'

      if ($processValue -ceq $storedValue) {
        $sessionStatus = 'active'
      } elseif ($entry.scope -eq 'machine') {
        $userValue = [System.Environment]::GetEnvironmentVariable(
          $name,
          [System.EnvironmentVariableTarget]::User
        )
        if ($null -ne $userValue -and $userValue -cne $storedValue) {
          $sessionStatus = 'shadowed'
        }
      }

      $items += @{
        name = $name
        scope = $entry.scope
        valueLength = $storedValue.Length
        sessionStatus = $sessionStatus
      }
    }
  }

  Write-JsonResult @{ ok = $true; result = @($items) }
} catch {
  Write-JsonResult @{ ok = $false; message = $_.Exception.Message }
}
`;

const GET_VALUE_SCRIPT = `${POWERSHELL_PREFIX}
try {
  $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $target = Get-Target ([string]$payload.scope)
  $value = [System.Environment]::GetEnvironmentVariable(
    [string]$payload.name,
    $target
  )
  if ($null -eq $value) {
    throw 'Environment variable was not found.'
  }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$value)
  Write-JsonResult @{
    ok = $true
    result = [System.Convert]::ToBase64String($bytes)
  }
} catch {
  Write-JsonResult @{ ok = $false; message = $_.Exception.Message }
}
`;

const SAVE_SCRIPT = `${POWERSHELL_PREFIX}
try {
  $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $target = Get-Target ([string]$payload.scope)
  $name = [string]$payload.name
  $value = [string]$payload.value
  $hasOriginal = $null -ne $payload.original

  if (-not $hasOriginal) {
    $existing = [System.Environment]::GetEnvironmentVariable($name, $target)
    if ($null -ne $existing) {
      throw 'An environment variable with this name already exists in this scope.'
    }
    [System.Environment]::SetEnvironmentVariable($name, $value, $target)
  } else {
    $originalName = [string]$payload.original.name
    $originalScope = [string]$payload.original.scope
    $originalTarget = Get-Target $originalScope
    $originalValue = [System.Environment]::GetEnvironmentVariable(
      $originalName,
      $originalTarget
    )
    if ($null -eq $originalValue) {
      throw 'The original environment variable no longer exists.'
    }

    $sameReference =
      $originalScope -eq [string]$payload.scope -and
      [System.StringComparer]::OrdinalIgnoreCase.Equals($originalName, $name)

    if ($sameReference) {
      [System.Environment]::SetEnvironmentVariable($name, $value, $target)
    } else {
      $existing = [System.Environment]::GetEnvironmentVariable($name, $target)
      if ($null -ne $existing) {
        throw 'An environment variable with this name already exists in this scope.'
      }

      [System.Environment]::SetEnvironmentVariable($name, $value, $target)
      try {
        [System.Environment]::SetEnvironmentVariable(
          $originalName,
          $null,
          $originalTarget
        )
      } catch {
        [System.Environment]::SetEnvironmentVariable($name, $null, $target)
        throw
      }
    }
  }

  Write-JsonResult @{ ok = $true; result = $true }
} catch {
  Write-JsonResult @{ ok = $false; message = $_.Exception.Message }
}
`;

const DELETE_SCRIPT = `${POWERSHELL_PREFIX}
try {
  $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $target = Get-Target ([string]$payload.scope)
  $name = [string]$payload.name
  $existing = [System.Environment]::GetEnvironmentVariable($name, $target)
  if ($null -eq $existing) {
    throw 'Environment variable was not found.'
  }
  [System.Environment]::SetEnvironmentVariable($name, $null, $target)
  Write-JsonResult @{ ok = $true; result = $true }
} catch {
  Write-JsonResult @{ ok = $false; message = $_.Exception.Message }
}
`;

export function normalizeEnvironmentVariableName(name: string): string {
  return name.trim().toUpperCase();
}

export function isSecretEnvironmentVariableName(name: string): boolean {
  const normalized = normalizeEnvironmentVariableName(name);
  return normalized.split("_").some((part) => SECRET_NAME_PARTS.has(part));
}

export function validateEnvironmentVariableName(name: unknown): string {
  if (typeof name !== "string") {
    throw new Error("Environment variable name is required.");
  }

  const normalized = normalizeEnvironmentVariableName(name);
  if (!normalized) {
    throw new Error("Environment variable name is required.");
  }
  if (normalized.length > MAX_NAME_LENGTH) {
    throw new Error(
      `Environment variable names must be ${MAX_NAME_LENGTH} characters or fewer.`,
    );
  }
  if (!ENVIRONMENT_NAME_PATTERN.test(normalized)) {
    throw new Error(
      "Use letters, numbers, and underscores, and do not start with a number.",
    );
  }
  if (!isSecretEnvironmentVariableName(normalized)) {
    throw new Error(
      "The name must include KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL, or PAT.",
    );
  }
  return normalized;
}

export function validateEnvironmentVariableScope(
  scope: unknown,
): EnvironmentVariableScope {
  if (scope !== "user" && scope !== "machine") {
    throw new Error("Environment variable scope must be user or machine.");
  }
  return scope;
}

export function validateEnvironmentVariableValue(value: unknown): string {
  if (typeof value !== "string" || !value.length) {
    throw new Error("Environment variable value is required.");
  }
  if (value.includes("\0")) {
    throw new Error(
      "Environment variable values cannot contain null characters.",
    );
  }
  if (value.length > MAX_VALUE_LENGTH) {
    throw new Error(
      `Environment variable values must be ${MAX_VALUE_LENGTH} characters or fewer.`,
    );
  }
  return value;
}

export function validateEnvironmentVariableRef(
  input: unknown,
): EnvironmentVariableRef {
  if (!input || typeof input !== "object") {
    throw new Error("Environment variable details are required.");
  }
  const value = input as Record<string, unknown>;
  return {
    name: validateEnvironmentVariableName(value.name),
    scope: validateEnvironmentVariableScope(value.scope),
  };
}

export function validateSaveEnvironmentVariableInput(
  input: unknown,
): SaveEnvironmentVariableInput {
  const target = validateEnvironmentVariableRef(input);
  const value = validateEnvironmentVariableValue(
    (input as Record<string, unknown>).value,
  );
  const originalValue = (input as Record<string, unknown>).original;
  return {
    ...target,
    value,
    ...(originalValue
      ? { original: validateEnvironmentVariableRef(originalValue) }
      : {}),
  };
}

export async function listEnvironmentVariables(): Promise<
  EnvironmentVariableSummary[]
> {
  ensureWindows();
  const rawItems = await runPowerShell<PowerShellListItem[]>(LIST_SCRIPT);
  if (!Array.isArray(rawItems)) {
    throw new Error("Windows returned an invalid environment variable list.");
  }

  const items: EnvironmentVariableSummary[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object" || typeof raw.name !== "string")
      continue;
    if (!isSecretEnvironmentVariableName(raw.name)) continue;

    const scope = validateEnvironmentVariableScope(raw.scope);
    const sessionStatus = validateSessionStatus(raw.sessionStatus);
    const valueLength =
      typeof raw.valueLength === "number" && Number.isFinite(raw.valueLength)
        ? Math.max(0, raw.valueLength)
        : 0;
    const name = normalizeEnvironmentVariableName(raw.name);
    items.push({
      id: `${scope}:${name}`,
      name,
      scope,
      valueLength,
      sessionStatus,
    });
  }

  return items.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "user" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function getEnvironmentVariableValue(
  input: unknown,
): Promise<string> {
  ensureWindows();
  const reference = validateEnvironmentVariableRef(input);
  const encodedValue = await runPowerShell<string>(
    GET_VALUE_SCRIPT,
    JSON.stringify(reference),
  );
  if (typeof encodedValue !== "string") {
    throw new Error("Windows returned an invalid environment variable value.");
  }
  return Buffer.from(encodedValue, "base64").toString("utf8");
}

export async function saveEnvironmentVariable(
  input: unknown,
): Promise<EnvironmentVariableSummary[]> {
  ensureWindows();
  const payload = validateSaveEnvironmentVariableInput(input);
  await runPowerShell<boolean>(SAVE_SCRIPT, JSON.stringify(payload));
  return listEnvironmentVariables();
}

export async function deleteEnvironmentVariable(
  input: unknown,
): Promise<EnvironmentVariableSummary[]> {
  ensureWindows();
  const payload = validateEnvironmentVariableRef(input);
  await runPowerShell<boolean>(DELETE_SCRIPT, JSON.stringify(payload));
  return listEnvironmentVariables();
}

function ensureWindows(): void {
  if (process.platform !== "win32") {
    throw new Error("Environment key management is available on Windows only.");
  }
}

function validateSessionStatus(
  value: unknown,
): EnvironmentVariableSessionStatus {
  if (
    value === "active" ||
    value === "restart-required" ||
    value === "shadowed"
  ) {
    return value;
  }
  return "restart-required";
}

async function runPowerShell<T>(script: string, input = ""): Promise<T> {
  const executable = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");

  return new Promise<T>((resolve, reject) => {
    const child = spawn(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodedCommand,
      ],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputLength = 0;
    let settled = false;

    const finishWithError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    const timeout = setTimeout(() => {
      child.kill();
      finishWithError(
        new Error("Windows environment variable request timed out."),
      );
    }, 10_000);

    child.stdout.on("data", (chunk: Buffer) => {
      outputLength += chunk.length;
      if (outputLength > 1_000_000) {
        child.kill();
        finishWithError(
          new Error("Windows returned too much environment data."),
        );
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => finishWithError(error));
    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timeout);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      if (code !== 0 || !output) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        finishWithError(
          new Error(detail || "Windows could not read environment variables."),
        );
        return;
      }

      try {
        const response = JSON.parse(output) as PowerShellResponse<T>;
        if (!response.ok) {
          finishWithError(
            new Error(
              response.message ||
                "Windows could not update the environment variable.",
            ),
          );
          return;
        }
        settled = true;
        resolve(response.result);
      } catch {
        finishWithError(
          new Error(
            "Windows returned an invalid environment variable response.",
          ),
        );
      }
    });

    child.stdin.end(input, "utf8");
  });
}
