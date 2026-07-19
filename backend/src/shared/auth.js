/**
 * Shared authentication helpers for Lambda handlers.
 * Handles JWT claim extraction, tenant isolation, and CloudFront origin verification.
 */

/**
 * Extract tenant identity from API Gateway JWT authorizer claims.
 * Falls back to request body for local development (SAM Local).
 *
 * @param {object} event - API Gateway v2 event
 * @returns {{ tenantId: string, userId: string, role: string|null } | null}
 */
function extractIdentity(event) {
    const jwtClaims = event.requestContext?.authorizer?.jwt?.claims;
    const body = JSON.parse(event.body || "{}");

    if (jwtClaims) {
        const tenantId = jwtClaims["custom:tenantId"];
        const userId = jwtClaims["username"] || jwtClaims["cognito:username"] || jwtClaims["sub"];
        const role = jwtClaims["custom:role"] || null;

        if (!tenantId) return null;

        return { tenantId, userId, role };
    }

    // Allow body-based identity only in local development
    if (process.env.AWS_SAM_LOCAL === "true") {
        return {
            tenantId: body.tenantId,
            userId: body.userId,
            role: body.role || null
        };
    }

    return null;
}

/**
 * Verify that the request originates from CloudFront
 * by checking the X-Origin-Verify custom header.
 *
 * @param {object} event - API Gateway v2 event
 * @returns {boolean} true if verification passes or is not configured
 */
function verifyOrigin(event) {
    const expectedSecret = process.env.ORIGIN_VERIFY_SECRET;
    if (!expectedSecret) return true; // Not configured — allow

    const headers = event.headers || {};
    const headerValue = headers["x-origin-verify"] || headers["X-Origin-Verify"];
    return headerValue === expectedSecret;
}

module.exports = { extractIdentity, verifyOrigin };
