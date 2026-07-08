const { ddbDocClient, TABLE_NAME } = require("../../shared/database");
const { QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const s3Client = new S3Client({});
const BUCKET_NAME = process.env.REPORT_BUCKET;

exports.handler = async (event) => {
    try {
        for (const record of event.Records) {
            const body = JSON.parse(record.body || "{}");
            const { tenantId, month } = body; 

            console.log(`Đang xử lý xuất báo cáo cho Tenant: ${tenantId}, Tháng: ${month}`);
            const ddbData = await ddbDocClient.send(new QueryCommand({
                TableName: TABLE_NAME,
                KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk_prefix)",
                ExpressionAttributeValues: {
                    ":pk": `TENANT#${tenantId}`,
                    ":sk_prefix": "USER#"
                }
            }));
            let reportContent = "UserId,Timestamp,Action,Device\n";
            ddbData.Items.forEach(item => {
                if (item.SK.includes(month)) {
                    reportContent += `${item.UserId},${item.Timestamp},${item.Action},${item.DeviceVerified}\n`;
                }
            });
            const fileName = `reports/${tenantId}/BaoCao_Thang_${month}_${Date.now()}.csv`;
            await s3Client.send(new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: fileName,
                Body: reportContent,
                ContentType: "text/csv"
            }));

            console.log(`Đã xuất và lưu file thành công lên S3: ${fileName}`);
        }
        return { status: "COMPLETED" };
    } catch (error) {
        console.error("Lỗi xuất báo cáo:", error);
        throw error;
    }
};