const { AppError } = require("./errors");

async function readJson(stream, maxBytes = 1_000_000) {
    let size = 0;
    const chunks = [];
    const iterator = stream.iterator ? stream.iterator({ destroyOnReturn: false }) : stream;
    for await (const chunk of iterator) {
        size += chunk.length;
        if (size > maxBytes) {
            if (stream.resume) stream.resume();
            throw new AppError(413, "body_too_large", "Превышен допустимый размер JSON.");
        }
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new AppError(400, "invalid_json", "Ожидался корректный JSON.");
    }
}

module.exports = { readJson };
