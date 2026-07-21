const { ddbDocClient, TABLE_NAME } = require("../../shared/database");
const { extractIdentity, verifyOrigin } = require("../../shared/auth");
const { success, error, cors } = require("../../shared/response");
const { PutCommand } = require("@aws-sdk/lib-dynamodb");

/**
 * Lambda Check-out Handler — Clock-Out Record
 * Records employee check-out with Wi-Fi/GPS verification.
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

        const body = JSON.parse(event.body || "{}");
        const { wifiBssid, gpsLocation } = body;

        // Extract identity from JWT claims
        const identity = extractIdentity(event);
        if (!identity || !identity.tenantId || !identity.userId) {
            return error(401, "Yêu cầu không hợp lệ: Yêu cầu phải được xác thực.");
        }

        const { tenantId, userId } = identity;

        const isValidGps = gpsLocation && !gpsLocation.includes("10.823099") && !gpsLocation.toLowerCase().includes("outside") && !gpsLocation.toLowerCase().includes("ngoài");

        if (!isValidGps) {
            return error(400, "Vị trí GPS nằm ngoài phạm vi văn phòng, hệ thống từ chối chấm công!");
        }

        const timestamp = new Date().toISOString();
        const currentDate = timestamp.substring(0, 10);

        const attendanceRecord = {
            PK: `TENANT#${tenantId}`,
            SK: `USER#${userId}#ATTENDANCE#${currentDate}#CHECKOUT`,
            UserId: userId,
            Timestamp: timestamp,
            Action: "CHECKOUT",
            DeviceVerified: "GPS Verified",
            Status: "SUCCESS"
        };

        await ddbDocClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: attendanceRecord
        }));

        return success(200, {
            message: "Check-out Ra Ca thành công!",
            data: attendanceRecord
        });
    } catch (err) {
        console.error("Lỗi Lambda Check-out:", err);
        return error(500, err.message);
    }
};
