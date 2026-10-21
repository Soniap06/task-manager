const { createHmac, timingSafeEqual } = require("node:crypto");
const { AppError } = require("./errors");

function safeEqual(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    return a.length === b.length && timingSafeEqual(a, b);
}

function createAuth({ username = "", password = "", secret = "" } = {}) {
    const enabled = Boolean(username || password || secret);
    const configured = Boolean(username && password && secret.length >= 32);
    const sign = (value) => createHmac("sha256", secret).update(value).digest("hex");
    function session(request) {
        if (!configured) return null;
        try {
            const pair = (request.headers.cookie || "").split(";").map((item) => item.trim()).find((item) => item.startsWith("tm_session="));
            const token = pair ? decodeURIComponent(pair.slice(11)) : "";
            const index = token.lastIndexOf(".");
            if (index < 1 || !safeEqual(token.slice(index + 1), sign(token.slice(0, index)))) return null;
            const data = JSON.parse(Buffer.from(token.slice(0, index), "base64url").toString());
            return data.username === username && Number.isFinite(data.exp) && data.exp > Date.now() ? data : null;
        } catch { return null; }
    }
    return {
        enabled,
        status(request) { return { enabled, configured, authenticated: Boolean(session(request)), username: session(request)?.username || null }; },
        require(request) {
            if (!enabled) return;
            if (!configured) throw new AppError(503, "auth_configuration", "Настройте DEMO_USERNAME, DEMO_PASSWORD и SESSION_SECRET (не менее 32 символов) в .env.");
            if (!session(request)) throw new AppError(401, "authentication", "Требуется вход.");
        },
        login(body) {
            if (!configured) throw new AppError(503, "auth_configuration", "Вход не настроен. Заполните DEMO_USERNAME, DEMO_PASSWORD и SESSION_SECRET в .env.");
            if (typeof body.username !== "string" || typeof body.password !== "string" || !safeEqual(body.username, username) || !safeEqual(body.password, password)) {
                throw new AppError(401, "credentials", "Неверный логин или пароль.");
            }
            const payload = Buffer.from(JSON.stringify({ username, exp: Date.now() + 8 * 60 * 60 * 1000 })).toString("base64url");
            return `tm_session=${payload}.${sign(payload)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`;
        },
        logout() { return "tm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"; }
    };
}

module.exports = { createAuth, safeEqual };
