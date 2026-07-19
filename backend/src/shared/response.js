/**
 * Standardized API response helpers for all Lambda handlers.
 * Eliminates duplicated header/response boilerplate.
 */

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Origin-Verify"
};

/**
 * Build a successful JSON response.
 * @param {number} statusCode - HTTP status (200, 201, etc.)
 * @param {object} body - Response payload
 * @returns {object} Lambda proxy response
 */
function success(statusCode, body) {
    return {
        statusCode,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        body: JSON.stringify(body)
    };
}

/**
 * Build an error JSON response.
 * @param {number} statusCode - HTTP status (400, 401, 403, 500, etc.)
 * @param {string} message - Human-readable error message
 * @returns {object} Lambda proxy response
 */
function error(statusCode, message) {
    return {
        statusCode,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        body: JSON.stringify({ message })
    };
}

/**
 * Build a CORS pre-flight response.
 * @returns {object} Lambda proxy response for OPTIONS
 */
function cors() {
    return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: ""
    };
}

module.exports = { success, error, cors, CORS_HEADERS };
