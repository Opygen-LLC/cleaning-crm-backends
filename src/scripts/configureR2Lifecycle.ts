import "dotenv/config";
import { assertRuntimeEnvironment } from "../config/runtimeEnv";
import { R2_PRIVATE_BUCKET } from "../config/ENV";
import { r2StorageService } from "../lib/storage/r2Storage.service";

const lifecycleXml = `<?xml version="1.0" encoding="UTF-8"?>
<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Rule>
    <ID>expire-temporary-media-after-one-day</ID>
    <Filter><Prefix>tmp/</Prefix></Filter>
    <Status>Enabled</Status>
    <Expiration><Days>1</Days></Expiration>
  </Rule>
  <Rule>
    <ID>abort-temporary-multipart-after-one-day</ID>
    <Filter><Prefix>tmp/</Prefix></Filter>
    <Status>Enabled</Status>
    <AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation></AbortIncompleteMultipartUpload>
  </Rule>
</LifecycleConfiguration>`;

const main = async () => {
  assertRuntimeEnvironment();
  await r2StorageService.putLifecycleConfiguration(R2_PRIVATE_BUCKET, lifecycleXml);
  const configured = await r2StorageService.getLifecycleConfiguration(R2_PRIVATE_BUCKET);
  const hasExpiry = configured.includes("expire-temporary-media-after-one-day") && configured.includes("<Prefix>tmp/</Prefix>");
  const hasMultipartAbort = configured.includes("abort-temporary-multipart-after-one-day");
  if (!hasExpiry || !hasMultipartAbort) throw new Error("R2 lifecycle verification failed after configuration.");
  console.log(JSON.stringify({ bucket: R2_PRIVATE_BUCKET, temporaryPrefix: "tmp/", expirationDays: 1, multipartAbortDays: 1, verified: true }, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
