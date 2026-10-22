const path = require("node:path");
const fs = require("node:fs");
const { AppError } = require("./errors");
const aiDefaults = require("../ai.config.example.json");

function loadAiConfig(env, root) {
    let settings;
    try {
        const filename = path.join(root, "ai.config.json");
        settings = JSON.parse(fs.readFileSync(filename, "utf8"));
    } catch (error) {
        if (error.code === "ENOENT") settings = aiDefaults;
        else throw new AppError(500, "ai_configuration", "Не удалось прочитать ai.config.json. Проверьте синтаксис JSON.");
    }
    const invalid = () => { throw new AppError(500, "ai_configuration", "Проверьте endpoint, model, apiKeyEnv, timeoutMs и generation в ai.config.json по примеру ai.config.example.json."); };
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) invalid();
    let endpoint;
    try { endpoint = new URL(settings.endpoint); } catch { invalid(); }
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash ||
        typeof settings.model !== "string" || !settings.model.trim() || settings.model.length > 200 ||
        typeof settings.apiKeyEnv !== "string" || !/^[A-Z_][A-Z\d_]*$/.test(settings.apiKeyEnv) ||
        !Number.isInteger(settings.timeoutMs) || settings.timeoutMs < 1000 || settings.timeoutMs > 600_000) invalid();
    const generation = settings.generation;
    const range = (key, min, max, integer = false) => Number.isFinite(generation?.[key]) && generation[key] >= min && generation[key] <= max && (!integer || Number.isInteger(generation[key]));
    const optionalRange = (key, min, max, integer = false) => !Object.hasOwn(generation, key) || range(key, min, max, integer);
    if (!generation || Object.keys(generation).some((key) => !Object.hasOwn(aiDefaults.generation, key)) ||
        !range("temperature", 0, 2) || !optionalRange("top_p", 0.01, 1) || !optionalRange("top_k", 0, 1000, true) ||
        !optionalRange("presence_penalty", -2, 2) || !optionalRange("repeat_penalty", 0.01, 2) || !range("max_tokens", 1, 8192, true)) invalid();
    const apiKey = env[settings.apiKeyEnv] || "";
    if (/[\r\n]/.test(apiKey)) invalid();
    return { endpoint: settings.endpoint, model: settings.model, timeoutMs: settings.timeoutMs, generation: { ...generation }, apiKey };
}

function loadConfig(env = process.env, root = path.join(__dirname, "..")) {
    const port = Number(env.PORT || 3000);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new AppError(500, "configuration", "PORT должен быть номером порта от 0 до 65535.");
    }
    const sharedOrigin = env.SHARED_ORIGIN || "";
    if (sharedOrigin) {
        let address;
        try { address = new URL(sharedOrigin); } catch { /* Проверка ниже. */ }
        if (!address || address.protocol !== "https:" || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(address.hostname) || address.origin !== sharedOrigin) {
            throw new AppError(500, "shared_configuration", "SHARED_ORIGIN должен быть точным HTTPS-адресом Tailscale Serve без пути и завершающего слеша.");
        }
        if (!env.DEMO_USERNAME || !env.DEMO_PASSWORD || (env.SESSION_SECRET || "").length < 32) {
            throw new AppError(500, "shared_configuration", "Для общей доски заполните DEMO_USERNAME, DEMO_PASSWORD и SESSION_SECRET (не менее 32 символов).");
        }
    }
    return {
        sharedOrigin,
        port,
        root,
        dataDir: path.resolve(root, env.DATA_DIR || ".data"),
        auth: { username: env.DEMO_USERNAME || "", password: env.DEMO_PASSWORD || "", secret: env.SESSION_SECRET || "" },
        webhookSecret: env.GITHUB_WEBHOOK_SECRET || "",
        github: {
            appId: env.GITHUB_APP_ID || "",
            installationId: env.GITHUB_INSTALLATION_ID || "",
            privateKeyPath: env.GITHUB_PRIVATE_KEY_PATH ? path.resolve(root, env.GITHUB_PRIVATE_KEY_PATH) : "",
            owner: env.GITHUB_OWNER || "",
            repo: env.GITHUB_REPO || "",
            baseBranch: env.GITHUB_BASE_BRANCH || "main"
        },
        llm: loadAiConfig(env, root)
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
