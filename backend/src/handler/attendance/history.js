const { ddbDocClient, TABLE_NAME } = require("../../shared/database");
const { extractIdentity, verifyOrigin } = require("../../shared/auth");
const { success, error, cors } = require("../../shared/response");
const { QueryCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");

/**
 * Lambda Attendance Handler — Query & Summary
 * Returns attendance history with optional date filtering and summary statistics.
 */
exports.handler = async (event) => {
    try {
        // CORS pre-flight
        if (event.requestContext?.http?.method === "OPTIONS") {
            return cors();
        }

        // CloudFront origin verification
        if (!verifyOrigin(event)) {
            return error(403, "Yêu cầu bị từ chối: Chỉ chấp nhận các kết nối đi qua CloudFront.");
        }

        // Extract identity from JWT claims
        const identity = extractIdentity(event);
        if (!identity || !identity.tenantId || !identity.userId) {
            return error(401, "Yêu cầu không hợp lệ: Yêu cầu phải được xác thực.");
        }

        const { tenantId, userId, role } = identity;
        const queryParams = event.queryStringParameters || {};
        const month = queryParams.month; // e.g. "2026-07"
        const limit = parseInt(queryParams.limit) || 50;

        let targetUserId = userId;

        // Privileged History Retrieval for Admin and Manager roles
        if (queryParams.userId && (role === "ADMIN" || role === "MANAGER")) {
            if (role === "MANAGER") {
                const targetUserGet = await ddbDocClient.send(new GetCommand({
                    TableName: TABLE_NAME,
                    Key: {
                        PK: `TENANT#${tenantId}`,
                        SK: `USER#${queryParams.userId}#METADATA`
                    }
                }));
                if (targetUserGet.Item && targetUserGet.Item.Role === "ADMIN") {
                    return error(403, "Quyền hạn không hợp lệ! Trưởng phòng (MANAGER) không có quyền xem thông tin của quản trị viên (ADMIN).");
                }
            }
            targetUserId = queryParams.userId;
        }

        // Query attendance records
        const skPrefix = `USER#${targetUserId}#ATTENDANCE#`;
        const result = await ddbDocClient.send(new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk_prefix)",
            ExpressionAttributeValues: {
                ":pk": `TENANT#${tenantId}`,
                ":sk_prefix": skPrefix
            },
            ScanIndexForward: false, // newest first
            Limit: limit
        }));

        let records = result.Items || [];

        // Filter by month if specified
        if (month) {
            records = records.filter(item => item.SK.includes(`#ATTENDANCE#${month}`));
        }

        // Build summary statistics
        const checkins = records.filter(r => r.Action === "CHECKIN");
        const checkouts = records.filter(r => r.Action === "CHECKOUT");
        const uniqueDays = new Set(records.map(r => r.Timestamp?.substring(0, 10)));

        const summary = {
            totalRecords: records.length,
            totalCheckins: checkins.length,
            totalCheckouts: checkouts.length,
            totalDays: uniqueDays.size,
            latestRecord: records.length > 0 ? {
                action: records[0].Action,
                timestamp: records[0].Timestamp,
                device: records[0].DeviceVerified
            } : null
        };

        return success(200, {
            history: records,
            summary,
            count: records.length
        });
    } catch (err) {
        console.error("Lỗi Lambda Attendance:", err);
        return error(500, err.message);
    }
};
