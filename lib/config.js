const path = require("node:path");
const { AppError } = require("./errors");

function loadConfig(env = process.env, root = path.join(__dirname, "..")) {
    const port = Number(env.PORT || 3000);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new AppError(500, "configuration", "PORT должен быть номером порта от 0 до 65535.");
    }
    return {
        port,
        root,
        dataDir: path.resolve(root, env.DATA_DIR || ".data"),
        github: {
            appId: env.GITHUB_APP_ID || "",
            installationId: env.GITHUB_INSTALLATION_ID || "",
            privateKeyPath: env.GITHUB_PRIVATE_KEY_PATH ? path.resolve(root, env.GITHUB_PRIVATE_KEY_PATH) : "",
            owner: env.GITHUB_OWNER || "",
            repo: env.GITHUB_REPO || "",
            baseBranch: env.GITHUB_BASE_BRANCH || "main"
        },
        llm: {
            endpoint: env.LM_STUDIO_ENDPOINT || "http://127.0.0.1:1234/v1/chat/completions",
            model: env.LM_STUDIO_MODEL || "qwen/qwen3.5-9b"
        }
    };
}

function validateGitHub(config, requireRepository = false) {
    if (!/^\d+$/.test(config.appId) || !/^\d+$/.test(config.installationId) || !config.privateKeyPath ||
        (requireRepository && (!/^[a-z\d-]+$/i.test(config.owner) || !/^[a-z\d_.-]+$/i.test(config.repo) ||
        !config.baseBranch || config.baseBranch.length > 200 || /[\x00-\x20]/.test(config.baseBranch)))) {
        throw new AppError(503, "github_configuration", "Заполните настройки GitHub App в серверном .env (ID приложения, ID установки и путь к ключу).");
    }
}

module.exports = { loadConfig, validateGitHub };
