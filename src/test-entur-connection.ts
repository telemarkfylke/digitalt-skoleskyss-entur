import dotenv from 'dotenv';
import { EnturApiService } from './services/entur-skoleskyss.service';
import { appLogger, flushLogs } from './services/logger.service';
import { calculateSchoolYear } from './utils';

// Load environment variables
dotenv.config();

async function testEnturConnection() {
  appLogger.debug('Starting Entur Skoleskyss API connection test');

  const enturService = new EnturApiService();

  try {
    // Test 1: Basic authentication
    appLogger.debug('=== Test 1: Authentication ===');
    const connectionTest = await enturService.testConnection();
    
    if (!connectionTest) {
      appLogger.error('Authentication failed. Check your environment variables');
      return;
    }

    // Test 2: Token info
    appLogger.debug('=== Test 2: Token Information ===');
    const tokenInfo = enturService.getTokenInfo();
    appLogger.debug('Has Token: {HasToken}', tokenInfo.hasToken);
    appLogger.debug('Token Expires: {TokenExpires}', tokenInfo.expiresAt?.toISOString());
    appLogger.debug('Is Expired: {IsExpired}', tokenInfo.isExpired);
    
    // Test 4: Validate request structure
    appLogger.debug('=== Test 4: Request Validation ===');
    const testRequest = enturService.createSkoleskyssRequest({
      studentId: 'test-student-123',
      applicationId: 'contract-456',
      firstName: 'Test',
      surname: 'Student',
      schoolId: 'school-001',
      schoolName: 'Test School',
      classId: 'class-vg1',
      className: 'VG1',
      email: 'test.student@example.com',
      phoneNumber: '12345678',
      phoneCountryCode: '+47',
      startDate: `2025-08-01`,
      endDate: `2026-06-30`,
      zones: [{ groupOfTariffZoneId: 'TEL:GroupOfTariffZones:1' }]
    });

    const validation = enturService.validateSkoleskyssRequest(testRequest);
    appLogger.debug('Test request validation: {ValidationJson}', JSON.stringify(validation));
    appLogger.debug('Example request structure: {RequestJson}', JSON.stringify(testRequest));

    appLogger.debug('Entur Skoleskyss API client test completed');
    appLogger.debug('Next steps: 1) Configure correct zone IDs 2) Test actual request creation 3) Implement business logic 4) Add production retry/error handling');

  } catch (error: any) {
    appLogger.error('Test failed: {ErrorMessage}', error.message);
    appLogger.error('Troubleshooting tips: verify .env variables, token URL, client permissions, and network connectivity');
  }
}

// Example usage of the Entur Skoleskyss API service
async function exampleUsage() {
  appLogger.debug('=== Example Usage ===');
  
  const enturService = new EnturApiService();

  // Get current school year for defaults
  const currentSchoolYear = calculateSchoolYear();
  const startYear = currentSchoolYear.graduationYear;
  const endYear = (currentSchoolYear.endYear + 1).toString();

  const month = new Date().getMonth() + 1; // getMonth is 0-indexed
  const day = new Date().getDate();
  const today = `${startYear}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  const nextYear = `${endYear}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;

  // Example 1: Creating a skoleskyss request
  const exampleRequest = enturService.createSkoleskyssRequest({
    studentId: '12345',
    applicationId: '11112',
    firstName: 'Test1',
    surname: 'Testesen1',
    schoolId: '14',
    schoolName: 'Vest-Telemark videregående skole, Dalen',
    classId: '1480',
    className: 'TPTIP1H---',
    email: 'test1.testesen1@telemarkfylke.no',
    phoneNumber: '11111111',
    phoneCountryCode: '+47',
    startDate: today,
    endDate: nextYear,
    zones: [{ groupOfTariffZoneId: 'TEL:GroupOfTariffZones:1' }]
  });

  appLogger.debug('Example skoleskyss request: {RequestJson}', JSON.stringify(exampleRequest));

  // Example 2: Batch creation
  appLogger.debug('Example batch requests for multiple students');
  
  const batchRequests = [
    enturService.createSkoleskyssRequest({
      studentId: '12346',
      applicationId: '11113',
      firstName: 'Test2',
      surname: 'Testesen2',
      schoolId: '14',
      schoolName: 'Vest-Telemark videregående skole, Dalen',
      classId: '1480',
      className: 'TPTIP1H---',
      email: 'test2.testesen2@telemarkfylke.no',
      phoneNumber: '11111112',
      phoneCountryCode: '+47',
      startDate: today,
      endDate: nextYear,
      zones: [{ groupOfTariffZoneId: 'TEL:GroupOfTariffZones:1' }]
    }),
    enturService.createSkoleskyssRequest({
      studentId: '12347',
      applicationId: '11114',
      firstName: 'Test3',
      surname: 'Testesen3',
      schoolId: '14',
      schoolName: 'Vest-Telemark videregående skole, Dalen',
      classId: '1480',
      className: 'TPTIP1H---',
      email: 'test3.testesen3@telemarkfylke.no',
      phoneNumber: '11111113',
      phoneCountryCode: '+47',
      startDate: today,
      endDate: nextYear,
      zones: [{ groupOfTariffZoneId: 'TEL:GroupOfTariffZones:1' }]
      }),
      enturService.createSkoleskyssRequest({
      studentId: '12348',
      applicationId: '11115',
      firstName: 'Test4',
      surname: 'Testesen4',
      schoolId: '14',
      schoolName: 'Vest-Telemark videregående skole, Dalen',
      classId: '1480',
      className: 'TPTIP1H---',
      email: 'test4.testesen4@telemarkfylke.no',
      phoneNumber: '11111114',
      phoneCountryCode: '+47',
      startDate: today,
      endDate: nextYear,
      zones: [{ groupOfTariffZoneId: 'TEL:GroupOfTariffZones:1' }]
      })
  ];

  appLogger.debug('Would create {BatchCount} skoleskyss requests in batch mode', batchRequests.length);
  
  try {
    const result = await enturService.createSkoleskyss(exampleRequest);
    appLogger.debug('Created skoleskyss: {ResultJson}', JSON.stringify(result));
    
    const batchResult = await enturService.createBatchSkoleskyss(batchRequests);
    appLogger.debug('Batch result: {BatchResultJson}', JSON.stringify(batchResult));
  } catch (error) {
    appLogger.debug('API call failed: {ErrorMessage}', (error as any)?.message || String(error));
  }
}

// Run the test
if (require.main === module) {
  testEnturConnection()
    .then(() => exampleUsage())
    .then(async () => {
      appLogger.debug('Test completed');
      await flushLogs();
      process.exit(0);
    })
    .catch(async (error) => {
      appLogger.error('Unhandled error: {ErrorMessage}', error?.message || String(error));
      await flushLogs();
      process.exit(1);
    });
}