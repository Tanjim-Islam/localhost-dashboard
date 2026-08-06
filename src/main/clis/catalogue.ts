import type { CliCategory, CliPackageSource, CliPlatform } from "./types";

export type CliVersionProbeDefinition = {
  commandName: string;
  args: readonly string[];
  timeoutMs: number;
  parser: "first-version" | "first-line" | "python-version";
  platforms?: readonly CliPlatform[];
  safe: true;
};

export type CliDefinition = {
  id: string;
  displayName: string;
  category: CliCategory;
  commands: readonly string[];
  aliases?: readonly string[];
  platforms?: readonly CliPlatform[];
  packages?: Partial<Record<CliPackageSource, readonly string[]>>;
  versionProbe?: CliVersionProbeDefinition;
  foundational?: boolean;
  preferVersionProbe?: boolean;
  alwaysProbeVersion?: boolean;
  incompleteProbe?: {
    commandName: string;
    args: readonly string[];
    emptyMeansIncomplete: boolean;
  };
};

const both: readonly CliPlatform[] = ["win32", "darwin"];

export const CLI_CATALOGUE: readonly CliDefinition[] = [
  {
    id: "codex",
    displayName: "OpenAI Codex CLI",
    category: "ai-coding",
    commands: ["codex"],
    packages: { npm: ["@openai/codex"], winget: ["OpenAI.Codex"] },
    versionProbe: probe("codex"),
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    category: "ai-coding",
    commands: ["claude"],
    packages: { npm: ["@anthropic-ai/claude-code"] },
    versionProbe: probe("claude"),
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    category: "ai-coding",
    commands: ["opencode"],
    packages: { npm: ["opencode-ai"] },
    versionProbe: probe("opencode"),
  },
  {
    id: "gemini-cli",
    displayName: "Gemini CLI",
    category: "ai-coding",
    commands: ["gemini"],
    packages: { npm: ["@google/gemini-cli"] },
    versionProbe: probe("gemini"),
  },
  {
    id: "qwen-code",
    displayName: "Qwen Code",
    category: "ai-coding",
    commands: ["qwen"],
    packages: { npm: ["@qwen-code/qwen-code"] },
    versionProbe: probe("qwen"),
  },
  {
    id: "github-copilot",
    displayName: "GitHub Copilot CLI",
    category: "ai-coding",
    commands: ["copilot", "github-copilot-cli"],
    packages: {
      npm: ["@github/copilot", "@githubnext/github-copilot-cli"],
      winget: ["GitHub.Copilot"],
    },
    versionProbe: probe("copilot"),
  },
  {
    id: "factory",
    displayName: "Factory CLI",
    category: "ai-coding",
    commands: ["droid", "factory"],
    packages: { npm: ["@factory-ai/cli"] },
    versionProbe: probe("droid"),
  },
  {
    id: "amp",
    displayName: "Amp",
    category: "ai-coding",
    commands: ["amp"],
    packages: { npm: ["@sourcegraph/amp"] },
    versionProbe: probe("amp"),
  },
  runtime("node", "Node.js", ["node"], true),
  {
    ...runtime("python", "Python", ["python", "python3", "py"], true),
    versionProbe: {
      commandName: "python",
      args: ["--version"],
      timeoutMs: 3_000,
      parser: "python-version",
      safe: true,
    },
  },
  runtime("java", "Java", ["java"], true),
  runtime("go", "Go", ["go"], true),
  runtime("rustc", "Rust", ["rustc"], true),
  {
    ...runtime("dotnet", ".NET", ["dotnet"], true),
    incompleteProbe: {
      commandName: "dotnet",
      args: ["--list-sdks"],
      emptyMeansIncomplete: true,
    },
  },
  runtime("php", "PHP", ["php"], true),
  runtime("ruby", "Ruby", ["ruby"], true),
  runtime("perl", "Perl", ["perl"], true),
  runtime("deno", "Deno", ["deno"], false),
  runtime("bun", "Bun", ["bun"], false, {
    winget: ["Oven-sh.Bun"],
    "homebrew-formula": ["bun"],
  }),
  manager("npm", "npm", ["npm"], true),
  manager("npx", "npx", ["npx"], true, null),
  {
    ...manager("pnpm", "pnpm", ["pnpm"], true),
    preferVersionProbe: true,
    alwaysProbeVersion: true,
  },
  manager("yarn", "Yarn", ["yarn"], true),
  manager("pip", "pip", ["pip", "pip3"], true),
  manager("pipx", "pipx", ["pipx"], true),
  manager("uv", "uv", ["uv", "uvx"], false),
  manager("poetry", "Poetry", ["poetry"], false),
  manager("cargo", "Cargo", ["cargo"], true),
  manager("rustup", "Rustup", ["rustup"], true),
  manager("composer", "Composer", ["composer"], false),
  manager("corepack", "Corepack", ["corepack"], true),
  manager("nvm", "NVM", ["nvm"], true, null),
  manager("winget", "Winget", ["winget"], true),
  manager("chocolatey", "Chocolatey", ["choco"], true),
  manager("scoop", "Scoop", ["scoop"], true),
  manager("homebrew", "Homebrew", ["brew"], true),
  manager("macports", "MacPorts", ["port"], true),
  build("maven", "Maven", ["mvn"]),
  build("gradle", "Gradle", ["gradle"]),
  build("cmake", "CMake", ["cmake"]),
  build("ninja", "Ninja", ["ninja"]),
  build("make", "Make", ["make"]),
  build("gcc", "GCC", ["gcc"]),
  build("clang", "Clang", ["clang"]),
  build("msbuild", "MSBuild", ["msbuild"], ["win32"]),
  cloud("aws", "AWS CLI", ["aws"]),
  cloud("azure", "Azure CLI", ["az"]),
  {
    ...cloud("gcloud", "Google Cloud CLI", ["gcloud"], {
      registry: ["Google Cloud SDK"],
    }),
    aliases: ["Google Cloud SDK"],
  },
  cloud("supabase", "Supabase CLI", ["supabase"], {
    npm: ["supabase"],
    "homebrew-formula": ["supabase/tap/supabase"],
  }),
  cloud("vercel", "Vercel CLI", ["vercel"], { npm: ["vercel"] }),
  cloud("netlify", "Netlify CLI", ["netlify"], {
    npm: ["netlify-cli"],
  }),
  cloud("railway", "Railway CLI", ["railway"], {
    npm: ["@railway/cli"],
  }),
  cloud("render", "Render CLI", ["render"]),
  cloud("fly", "Fly.io CLI", ["flyctl"]),
  cloud("heroku", "Heroku CLI", ["heroku"]),
  cloud("firebase", "Firebase CLI", ["firebase"], {
    npm: ["firebase-tools"],
  }),
  cloud("wrangler", "Cloudflare Wrangler", ["wrangler"], {
    npm: ["wrangler"],
  }),
  cloud("terraform", "Terraform", ["terraform"]),
  cloud("pulumi", "Pulumi", ["pulumi"]),
  infra(
    "docker",
    "Docker",
    ["docker"],
    true,
    {
      registry: ["Docker Desktop"],
      winget: ["Docker.DockerDesktop"],
    },
    true,
  ),
  infra("docker-compose", "Docker Compose", ["docker-compose"]),
  infra("kubectl", "kubectl", ["kubectl"]),
  infra("helm", "Helm", ["helm"]),
  infra("minikube", "Minikube", ["minikube"]),
  infra("kind", "Kind", ["kind"]),
  infra("podman", "Podman", ["podman"]),
  database("postgresql", "PostgreSQL Tools", ["psql", "pg_dump", "pg_restore"]),
  database("mongodb", "MongoDB Tools", ["mongosh", "mongo", "mongod"]),
  database("atlas", "MongoDB Atlas CLI", ["atlas"]),
  database("prisma", "Prisma CLI", ["prisma"], {
    npm: ["prisma", "@prisma/cli"],
  }),
  database("neon", "Neon CLI", ["neonctl"], { npm: ["neonctl"] }),
  database("planetscale", "PlanetScale CLI", ["pscale"]),
  database("turso", "Turso CLI", ["turso"]),
  database("redis", "Redis CLI", ["redis-cli"]),
  database("sqlite", "SQLite", ["sqlite3"]),
  database("stripe", "Stripe CLI", ["stripe"]),
  database("sanity", "Sanity CLI", ["sanity"], {
    npm: ["@sanity/cli"],
  }),
  database("shopify", "Shopify CLI", ["shopify"], {
    npm: ["@shopify/cli"],
  }),
  developer("git", "Git", ["git"], true),
  developer("github", "GitHub CLI", ["gh"]),
  developer("android-platform-tools", "Android Platform Tools", [
    "adb",
    "fastboot",
  ]),
  developer("eas", "EAS CLI", ["eas"], false, { npm: ["eas-cli"] }),
  developer("ngrok", "ngrok", ["ngrok"]),
] as const;

export function getCliDefinitions(platform: CliPlatform): CliDefinition[] {
  return CLI_CATALOGUE.filter(
    (definition) =>
      !definition.platforms || definition.platforms.includes(platform),
  ).map((definition) => ({ ...definition }));
}

export function getCliDefinition(productId: string): CliDefinition | undefined {
  return CLI_CATALOGUE.find((definition) => definition.id === productId);
}

export function findCliByCommand(
  commandName: string,
  platform: CliPlatform,
): CliDefinition | undefined {
  const normalized = commandName.trim().toLowerCase();
  return getCliDefinitions(platform).find((definition) =>
    definition.commands.some((command) => command.toLowerCase() === normalized),
  );
}

export function findCliByPackage(
  source: CliPackageSource,
  packageId: string,
  platform: CliPlatform,
): CliDefinition | undefined {
  const normalized = packageId.trim().toLowerCase();
  const packageSources =
    source === "pnpm" || source === "yarn-classic" || source === "bun"
      ? [source, "npm" as const]
      : [source];
  return getCliDefinitions(platform).find((definition) =>
    packageSources.some((candidateSource) =>
      definition.packages?.[candidateSource]?.some(
        (candidate) => candidate.toLowerCase() === normalized,
      ),
    ),
  );
}

function probe(commandName: string): CliVersionProbeDefinition {
  return {
    commandName,
    args: ["--version"],
    timeoutMs: 3_000,
    parser: "first-version",
    safe: true,
  };
}

function runtime(
  id: string,
  displayName: string,
  commands: string[],
  foundational: boolean,
  packages?: {
    winget?: string[];
    "homebrew-formula"?: string[];
  },
): CliDefinition {
  return {
    id,
    displayName,
    category: "runtime",
    commands,
    platforms: both,
    foundational,
    packages: {
      ...(packages?.winget ? { winget: packages.winget } : {}),
      ...(packages?.["homebrew-formula"]
        ? { "homebrew-formula": packages["homebrew-formula"] }
        : {}),
    },
    versionProbe: probe(commands[0]),
  };
}

function manager(
  id: string,
  displayName: string,
  commands: string[],
  foundational: boolean,
  versionProbe: CliVersionProbeDefinition | null = probe(commands[0]),
): CliDefinition {
  return {
    id,
    displayName,
    category: "package-manager",
    commands,
    platforms: both,
    foundational,
    ...(versionProbe ? { versionProbe } : {}),
  };
}

function build(
  id: string,
  displayName: string,
  commands: string[],
  platforms: CliPlatform[] = [...both],
): CliDefinition {
  return {
    id,
    displayName,
    category: "build-tool",
    commands,
    platforms,
    versionProbe: probe(commands[0]),
  };
}

function cloud(
  id: string,
  displayName: string,
  commands: string[],
  packages?: Partial<Record<CliPackageSource, string[]>>,
): CliDefinition {
  return {
    id,
    displayName,
    category: "cloud",
    commands,
    platforms: both,
    packages,
    versionProbe: id === "firebase" ? undefined : probe(commands[0]),
  };
}

function infra(
  id: string,
  displayName: string,
  commands: string[],
  foundational = false,
  packages?: Partial<Record<CliPackageSource, string[]>>,
  preferVersionProbe = false,
): CliDefinition {
  return {
    id,
    displayName,
    category: "infrastructure",
    commands,
    platforms: both,
    foundational,
    packages,
    preferVersionProbe,
    versionProbe: probe(commands[0]),
  };
}

function database(
  id: string,
  displayName: string,
  commands: string[],
  packages?: Partial<Record<CliPackageSource, string[]>>,
): CliDefinition {
  return {
    id,
    displayName,
    category: "database",
    commands,
    platforms: both,
    packages,
    versionProbe: probe(commands[0]),
  };
}

function developer(
  id: string,
  displayName: string,
  commands: string[],
  foundational = false,
  packages?: Partial<Record<CliPackageSource, string[]>>,
): CliDefinition {
  return {
    id,
    displayName,
    category: "developer-tool",
    commands,
    platforms: both,
    foundational,
    packages,
    versionProbe: probe(commands[0]),
  };
}
