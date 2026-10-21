const { loadConfig } = require("../lib/config");
const { GitHubClient } = require("../lib/github");
const { publicError } = require("../lib/errors");

async function main() {
    const { github } = loadConfig();
    const client = new GitHubClient(github);
    const repositories = await client.listRepositories();
    console.log(`GitHub App: доступ к установке подтверждён, репозиториев: ${repositories.length}.`);
    for (const repository of repositories) console.log(`- ${repository.full_name}`);
    console.log("Ветки и содержимое репозитория не изменялись. Токены не сохранялись.");
}

main().catch((error) => {
    console.error(publicError(error).message);
    process.exitCode = 1;
});
