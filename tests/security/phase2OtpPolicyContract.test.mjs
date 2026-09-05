import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath) => readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');

test('registration OTP policy fails closed and is server authoritative', () => {
  const platformConfig = read('src/lib/utils/platformConfig.ts');
  const authService = read('src/modules/Auth/auth.service.ts');

  assert.match(platformConfig, /requireEmailOtpVerification:\s*true/);
  assert.match(platformConfig, /return typeof candidate === "boolean" \? candidate : true/);
  assert.match(authService, /requireEmailOtpVerification \?\? true/);
  assert.match(authService, /requireEmailVerification:\s*verificationRequired/);
});

test('OTP-disabled registrations are created active/verified and do not enqueue a verification email', () => {
  const provisioning = read('src/modules/Auth/accountProvisioning.service.ts');
  const authService = read('src/modules/Auth/auth.service.ts');

  assert.match(provisioning, /emailVerified:\s*input\.requireEmailVerification === false/);
  assert.match(provisioning, /status:\s*input\.requireEmailVerification === false \? AccountStatus\.ACTIVE : AccountStatus\.PENDING/);
  assert.match(provisioning, /if \(input\.requireEmailVerification !== false\)/);
  assert.match(authService, /const authentication = await login\(\{ email, password \}, metadata\)/);
  assert.match(authService, /verificationRequired:\s*false as const/);
});

test('existing unverified users remain protected independently of the registration switch', () => {
  const authService = read('src/modules/Auth/auth.service.ts');
  const routes = read('src/modules/SuperAdmin/superAdmin.routes.ts');

  assert.match(authService, /if \(!user\.emailVerified\)/);
  assert.match(authService, /EMAIL_NOT_VERIFIED/);
  assert.match(routes, /router\.patch\("\/users\/:id\/verify",\s*isSuperAdmin/);
});

test('Super Admin OTP policy changes are protected and receive a dedicated before/after audit event', () => {
  const routes = read('src/modules/SuperAdmin/superAdmin.routes.ts');
  const controller = read('src/modules/SuperAdmin/superAdmin.controller.ts');
  const validation = read('src/modules/SuperAdmin/tenantAdmin.validation.ts');

  assert.match(routes, /router\.patch\(\s*"\/platform-config",\s*isSuperAdmin/);
  assert.match(validation, /requireEmailOtpVerification:\s*z\.boolean\(\)\.optional\(\)/);
  assert.match(controller, /action:\s*"PLATFORM_AUTH_SETTING_UPDATED"/);
  assert.match(controller, /scope:\s*"NEW_REGISTRATIONS_ONLY"/);
  assert.match(controller, /before:\s*\{ requireEmailOtpVerification: previousEmailOtpRequired \}/);
  assert.match(controller, /after:\s*\{ requireEmailOtpVerification: nextEmailOtpRequired \}/);
});
