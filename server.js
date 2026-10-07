const http = require("http");
const fs = require("fs");
const path = require("path");

const port = 3000;
const root = __dirname;
const lmStudioEndpoint = "http://127.0.0.1:1234/v1/chat/completions";

const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8"
};

const server = http.createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
    }

    if (request.method === "POST" && request.url === "/api/ai") {
        try {
            const body = await readRequestBody(request);
            const lmResponse = await fetch(lmStudioEndpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body
            });

            response.writeHead(lmResponse.status, {
                "Content-Type": "application/json; charset=utf-8"
            });
            response.end(await lmResponse.text());
        } catch (error) {
            response.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
            response.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    if (request.method !== "GET") {
        response.writeHead(405);
        response.end("Method Not Allowed");
        return;
    }

    const requestedPath = request.url === "/" ? "/index.html" : request.url;
    const filePath = path.join(root, requestedPath);

    if (!filePath.startsWith(root)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
    }

    fs.readFile(filePath, (error, file) => {
        if (error) {
            response.writeHead(error.code === "ENOENT" ? 404 : 500);
            response.end("File not found");
            return;
        }

        response.writeHead(200, {
            "Content-Type": contentTypes[path.extname(filePath)] || "text/plain; charset=utf-8"
        });
        response.end(file);
    });
});

function readRequestBody(request) {
    return new Promise((resolve, reject) => {
        let body = "";

        request.on("data", (chunk) => {
            body += chunk;

            if (body.length > 1_000_000) {
                reject(new Error("Запрос слишком большой"));
                request.destroy();
            }
        });
        request.on("end", () => resolve(body));
        request.on("error", reject);
    });
}

server.listen(port, "127.0.0.1", () => {
    console.log(`Task Manager доступен по адресу http://127.0.0.1:${port}`);
});
