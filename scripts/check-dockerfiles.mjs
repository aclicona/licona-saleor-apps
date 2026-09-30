// Guard de drift: cada Dockerfile debe copiar el manifiesto de TODAS las Apps
// del workspace en cada etapa que ejecuta `pnpm install --frozen-lockfile`.
// Docker no admite globs que conserven directorios, asi que la lista sigue
// siendo manual; este script hace que olvidarse de ella falle aqui y no en Railway.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const errors = [];

const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
const globs = [...workspace.matchAll(/^\s*-\s*['"]?([^'"\s#]+\/\*)['"]?/gm)].map((m) => m[1]);
const supported = ["apps/*", "packages/*"];
for (const g of globs) {
  if (!supported.includes(g)) errors.push(`pnpm-workspace.yaml declara '${g}', que este guard no sabe verificar`);
}

const apps = readdirSync(join(root, "apps"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, "apps", d.name, "package.json")))
  .map((d) => d.name);

for (const app of apps) {
  const file = join("apps", app, "Dockerfile");
  if (!existsSync(join(root, file))) continue;
  const stages = readFileSync(join(root, file), "utf8").split(/^FROM /m).slice(1);
  stages.forEach((stage, i) => {
    if (!/pnpm install/.test(stage)) return;
    const copies = [...stage.matchAll(/^COPY\s+(?!--from)(\S+)/gm)].map((m) => m[1].replace(/\/$/, ""));
    if (!copies.includes("packages")) errors.push(`${file} (etapa ${i + 1}): falta COPY packages`);
    for (const other of apps) {
      const ok = copies.includes(`apps/${other}`) || copies.includes(`apps/${other}/package.json`);
      if (!ok) errors.push(`${file} (etapa ${i + 1}): falta COPY apps/${other}/package.json`);
    }
  });
}

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join("\n"));
  process.exit(1);
}
console.log(`Dockerfiles en sincronía con el workspace (apps: ${apps.join(", ")})`);
