class AppError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function publicError(error) {
    if (error instanceof AppError) return { code: error.code, message: error.message };
    return { code: "internal_error", message: "Внутренняя ошибка. Проверьте доступность локального хранилища и повторите запрос." };
}

module.exports = { AppError, publicError };
