const { ddbDocClient, TABLE_NAME } = require("../../shared/database");
const { UpdateCommand } = require("@aws-sdk/lib-dynamodb");

exports.handler = async (event) => {
    try {
        // 1. Handle CORS Pre-flight Options Request
        if (event.requestContext && event.requestContext.http.method === "OPTIONS") {
            return {
                statusCode: 200,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "PATCH,OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type,Authorization"
                },
                body: ""
            };
        }

        // 2. Perimeter Security: Verify request originates from CloudFront
        const headers = event.headers || {};
        const originVerifyHeader = headers["x-origin-verify"] || headers["X-Origin-Verify"];
        const expectedOriginSecret = process.env.ORIGIN_VERIFY_SECRET;

        if (expectedOriginSecret && originVerifyHeader !== expectedOriginSecret) {
            console.warn("Cảnh báo: Yêu cầu trực tiếp bị chặn do thiếu/sai mã xác thực nguồn.");
            return {
                statusCode: 403,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                body: JSON.stringify({ message: "Yêu cầu bị từ chối: Chỉ chấp nhận các kết nối đi qua CloudFront." })
            };
        }

        const body = JSON.parse(event.body || "{}");
        const { fullName, email, phone } = body;

        // 3. Tenant Isolation & Identity Enforcement via Cognito JWT Claims
        let tenantId = body.tenantId;
        let userId = body.userId;

        const jwtClaims = event.requestContext?.authorizer?.jwt?.claims;
        if (jwtClaims) {
            const tokenTenantId = jwtClaims["custom:tenantId"];
            const tokenUserId = jwtClaims["username"] || jwtClaims["cognito:username"] || jwtClaims["sub"];
            
            if (!tokenTenantId) {
                return {
                    statusCode: 403,
                    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                    body: JSON.stringify({ message: "Quyền truy cập bị từ chối: Không tìm thấy Mã Doanh Nghiệp (tenantId) trong token!" })
                };
            }
            
            // Enforce authenticated context: override body parameters with claims
            tenantId = tokenTenantId;
            userId = tokenUserId;
        } else {
            // In non-local environments, requests must be authenticated via Cognito
            if (process.env.AWS_SAM_LOCAL !== 'true') {
                return {
                    statusCode: 401,
                    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                    body: JSON.stringify({ message: "Yêu cầu không hợp lệ: Yêu cầu phải được xác thực." })
                };
            }
        }

        if (!tenantId || !userId) {
            return {
                statusCode: 400,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                body: JSON.stringify({ message: "Thiếu thông tin tenantId hoặc userId bắt buộc!" })
            };
        }

        // 4. Build DynamoDB update parameters dynamically
        const updateExpressions = [];
        const expressionAttributeNames = {};
        const expressionAttributeValues = {};

        if (fullName !== undefined) {
            updateExpressions.push("#fn = :fullName");
            expressionAttributeNames["#fn"] = "FullName";
            expressionAttributeValues[":fullName"] = fullName;
        }
        if (email !== undefined) {
            updateExpressions.push("#em = :email");
            expressionAttributeNames["#em"] = "Email";
            expressionAttributeValues[":email"] = email;
        }
        if (phone !== undefined) {
            updateExpressions.push("#ph = :phone");
            expressionAttributeNames["#ph"] = "Phone";
            expressionAttributeValues[":phone"] = phone;
        }

        if (updateExpressions.length === 0) {
            return {
                statusCode: 400,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                body: JSON.stringify({ message: "Không có thông tin thay đổi nào được gửi!" })
            };
        }

        await ddbDocClient.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: {
                PK: `TENANT#${tenantId}`,
                SK: `USER#${userId}#METADATA`
            },
            UpdateExpression: "SET " + updateExpressions.join(", "),
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues
        }));

        return {
            statusCode: 200,
            headers: { 
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            },
            body: JSON.stringify({ message: "Cập nhật hồ sơ thành công!" })
        };
    } catch (error) {
        console.error("Lỗi cập nhật hồ sơ:", error);
        return {
            statusCode: 500,
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ error: error.message })
        };
    }
};
