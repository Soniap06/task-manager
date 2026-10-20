import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const jsFiles = [...new Set(files)].filter((file) => /\.(?:js|mjs|cjs)$/.test(file) && existsSync(path.join(root, file)));
// Локальный клиент игнорируется git, но при наличии тоже должен иметь корректный синтаксис.
if (existsSync(path.join(root, "ai-api.js")) && !jsFiles.includes("ai-api.js")) jsFiles.push("ai-api.js");
let failed = false;
for (const file of jsFiles) {
    const result = spawnSync(process.execPath, ["--check", path.join(root, file)], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) failed = true;
}
for (const page of ["index.html", "projects.html"]) {
    const html = readFileSync(path.join(root, page), "utf8");
    for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
        const resource = match[1];
        if (/^(?:[a-z]+:|\/\/|#)/i.test(resource)) continue;
        const localPath = resource.split(/[?#]/)[0].replace(/^\//, "");
        if (!existsSync(path.join(root, localPath))) {
            console.error(`Не найден ресурс ${resource} в ${page}.`);
            failed = true;
        }
    }
}
if (failed) process.exitCode = 1;
else console.log(`Проверка пройдена: синтаксис ${jsFiles.length} JS-файлов и локальные ресурсы обеих HTML-страниц. Поведение приложения не проверялось.`);
