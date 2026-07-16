'use strict';
// electron-builder afterSign hook: notarize the signed app with Apple's
// notarytool. Reads credentials from env (set as GitHub secrets); skips
// cleanly when they're absent so unsigned builds still work.

const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('notarize: skipped (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set)');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${context.appOutDir}/${appName}.app`;
  console.log('notarize: submitting ' + appPath + ' to Apple…');
  await notarize({
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID
  });
  console.log('notarize: complete for ' + appName);
};
