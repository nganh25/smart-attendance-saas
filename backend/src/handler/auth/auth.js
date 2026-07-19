const { CognitoIdentityProviderClient, SignUpCommand, ConfirmSignUpCommand, InitiateAuthCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { PutCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { ddbDocClient } = require("../../shared/database");
const { success, error, cors } = require("../../shared/response");
const { verifyOrigin } = require("../../shared/auth");

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || "ap-southeast-1" });
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const TABLE_NAME = process.env.DYNAMODB_TABLE;

function formatPhone(phone) {
    if (!phone) return phone;
    let trimmed = phone.trim();
    if (trimmed.startsWith("+")) return trimmed;
    if (trimmed.startsWith("0")) return "+84" + trimmed.slice(1);
    return "+84" + trimmed;
}

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

        const path = event.requestContext?.http?.path || "";
        const body = JSON.parse(event.body || "{}");

        // ─── 1. REGISTER REQUEST ───
        if (path.includes("/auth/register/request")) {
            const { tenantId, userId, password, fullName, email, phone, otpType } = body;

            if (!tenantId || !userId || !password || !email || !phone) {
                return error(400, "Vui lòng điền đầy đủ thông tin doanh nghiệp và tài khoản!");
            }

            const formattedPhone = formatPhone(phone);
            const cognitoUsername = `${tenantId}#${userId}`;

            try {
                // Call Cognito SignUp
                await cognitoClient.send(new SignUpCommand({
                    ClientId: CLIENT_ID,
                    Username: cognitoUsername,
                    Password: password,
                    UserAttributes: [
                        { Name: "email", Value: email },
                        { Name: "phone_number", Value: formattedPhone },
                        { Name: "custom:tenantId", Value: tenantId },
                        { Name: "custom:role", Value: "EMPLOYEE" }
                    ]
                }));

                const channelText = otpType === "PHONE" ? `Số điện thoại (${phone})` : `Email (${email})`;
                return success(200, {
                    message: `Mã xác thực OTP đã được gửi tới ${channelText} của bạn qua hệ thống AWS Cognito! Vui lòng kiểm tra hộp thư.`
                });
            } catch (err) {
                console.error("Lỗi Cognito SignUp:", err);
                return error(400, "Lỗi đăng ký tài khoản: " + err.message);
            }
        }

        // ─── 2. REGISTER VERIFY ───
        if (path.includes("/auth/register/verify")) {
            const { tenantId, userId, otpCode } = body;

            if (!tenantId || !userId || !otpCode) {
                return error(400, "Thiếu thông tin xác thực bắt buộc!");
            }

            const cognitoUsername = `${tenantId}#${userId}`;

            try {
                // Confirm user registration in Cognito
                await cognitoClient.send(new ConfirmSignUpCommand({
                    ClientId: CLIENT_ID,
                    Username: cognitoUsername,
                    ConfirmationCode: otpCode
                }));

                // Write metadata record to DynamoDB:
                const userRecord = {
                    PK: `TENANT#${tenantId}`,
                    SK: `USER#${userId}#METADATA`,
                    FullName: userId, // Default to userId, can be updated later
                    Role: "EMPLOYEE",
                    IsActive: true,
                    IsVerified: true,
                    CreatedAt: new Date().toISOString()
                };

                await ddbDocClient.send(new PutCommand({
                    TableName: TABLE_NAME,
                    Item: userRecord
                }));

                return success(200, {
                    message: "Xác thực thành công! Tài khoản nhân viên của bạn đã được kích hoạt an toàn trong hệ thống AWS."
                });
            } catch (err) {
                console.error("Lỗi Cognito ConfirmSignUp:", err);
                return error(400, "Mã xác thực OTP không chính xác hoặc đã hết hạn: " + err.message);
            }
        }

        // ─── 3. LOGIN ───
        if (path.includes("/auth/login")) {
            const { tenantId, userId, password } = body;

            if (!tenantId || !userId || !password) {
                return error(400, "Vui lòng nhập đầy đủ mã công ty, tài khoản và mật khẩu!");
            }

            const cognitoUsername = `${tenantId}#${userId}`;

            try {
                // Call Cognito InitiateAuth for USER_PASSWORD_AUTH
                const authResult = await cognitoClient.send(new InitiateAuthCommand({
                    ClientId: CLIENT_ID,
                    AuthFlow: "USER_PASSWORD_AUTH",
                    AuthParameters: {
                        USERNAME: cognitoUsername,
                        PASSWORD: password
                    }
                }));

                const idToken = authResult.AuthenticationResult.IdToken;

                // Load user metadata from DynamoDB
                const userQuery = await ddbDocClient.send(new GetCommand({
                    TableName: TABLE_NAME,
                    Key: {
                        PK: `TENANT#${tenantId}`,
                        SK: `USER#${userId}#METADATA`
                    }
                }));

                const userMetadata = userQuery.Item || {};

                return success(200, {
                    message: "Đăng nhập thành công!",
                    token: idToken,
                    user: {
                        tenantId,
                        userId,
                        fullName: userMetadata.FullName || userId,
                        email: userMetadata.Email || "",
                        phone: userMetadata.Phone || "",
                        role: userMetadata.Role || "EMPLOYEE"
                    }
                });
            } catch (err) {
                console.error("Lỗi Cognito InitiateAuth:", err);
                return error(401, "Mã công ty, tài khoản hoặc mật khẩu không chính xác!");
            }
        }

        return error(405, "Phương thức hoặc đường dẫn không hỗ trợ.");
    } catch (err) {
        console.error("Lỗi hệ thống Auth:", err);
        return error(500, err.message);
    }
};
