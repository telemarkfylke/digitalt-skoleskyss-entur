import { EnturAuthClient } from './entur-auth.service';
import { appLogger } from './logger.service';
import { createHarryPotterMockStudentDetails } from '../utils';

export interface PostSkoleskyssRequest {
  organisationId?: number; // 27 for Farte (Not needed, EnTur got this)
  studentId: string | number; // elev id
  applicationId: string | number; // søknads id
  validity: {
    startDate: string; // ISO date format: YYYY-MM-DD
    endDate: string;   // ISO date format: YYYY-MM-DD
    zones: Array<
      | { fromZoneId: string; toZoneId: string; }
      | { groupOfTariffZoneId: string; }
    >;
  };
  studentDetails?: {
    firstName?: string;
    surname?: string;
    school?: {
      id: string | number;
      name: string;
    };
    class?: {
      id: string | number;
      name: string;
    };
    email?: string;
    phone?: {
      number: string;
      countryCode?: string; // +47
    };
  };
}

export interface SkoleskyssResponse {
  id?: string;
  status?: 'created' | 'active' | 'cancelled' | 'expired';
  organisationId?: number;
  studentId: string | number;
  applicationId: string | number;
  validity: {
    startDate: string;
    endDate: string;
    zones: Array<
      | { fromZoneId: string; toZoneId: string; }
      | { groupOfTariffZoneId: string; }
    >;
  };
  studentDetails?: {
    firstName?: string;
    surname?: string;
    school?: {
      id: string | number;
      name: string;
    };
    class?: {
      id: string | number;
      name: string;
    };
    email?: string;
    phone?: {
      number: string;
      countryCode?: string;
    };
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface EnturApiResponse<T> {
  data: T;
  meta?: {
    total?: number;
    page?: number;
    pageSize?: number;
  };
  errors?: Array<{
    code: string;
    message: string;
    field?: string;
  }>;
}

export class EnturApiService {
  private authClient: EnturAuthClient;
  private readonly useMockStudentDetails: boolean;

  constructor() {
    this.authClient = new EnturAuthClient();
    this.useMockStudentDetails = (process.env.ENTUR_AUDIENCE || '').toLowerCase().includes('staging');

    if (this.useMockStudentDetails) {
      appLogger.warn('ENTUR_AUDIENCE contains "staging". studentDetails will be replaced with mock data.');
    }
  }

  /**
   * Test the Entur API connection
   */
  public async testConnection(): Promise<boolean> {
    return await this.authClient.testConnection();
  }

  /**
   * Create a new school transport request (skoleskyss)
   */
  public async createSkoleskyss(request: PostSkoleskyssRequest): Promise<SkoleskyssResponse> {
    appLogger.info(
      'Creating skoleskyss for applicationId {ApplicationId} and studentId {StudentId}',
      request.applicationId,
      request.studentId
    );
    
    return await this.authClient.apiRequest('/skoleskyss', {
      method: 'POST',
      body: request
    });
  }

  // /**
  //  * TODO: Cancel/delete an existing skoleskyss 
  //  */
  // public async cancelSkoleskyss(externalRef: string): Promise<void> {
  //   console.log(`Cancelling skoleskyss for recipient: ${externalRef}`);
    
  //   return await this.authClient.apiRequest(`/skoleskyss/${externalRef}`, {
  //     method: 'DELETE'
  //   });
  // }

  /**
   * Create multiple skoleskyss requests sequentially.
   * Note: This is not a true server-side batch endpoint.
   */
  public async createManySkoleskyssSequentially(requests: PostSkoleskyssRequest[]): Promise<{
    success: number;
    failed: number;
    results: Array<{
      request: PostSkoleskyssRequest;
      success: boolean;
      response?: SkoleskyssResponse;
      error?: string;
    }>;
  }> {
    appLogger.info('Creating batch of {RequestCount} skoleskyss requests', requests.length);
    
    let success = 0;
    let failed = 0;
    const results = [];

    for (const request of requests) {
      try {
        const response = await this.createSkoleskyss(request);
        results.push({
          request,
          success: true,
          response
        });
        success++;
        appLogger.info(
          'Created skoleskyss for applicationId {ApplicationId} and studentId {StudentId}',
          request.applicationId,
          request.studentId
        );
      } catch (error: any) {
        results.push({
          request,
          success: false,
          error: error.message
        });
        failed++;
        appLogger.error(
          'Failed to create skoleskyss for applicationId {ApplicationId} and studentId {StudentId}: {ErrorMessage}',
          request.applicationId,
          request.studentId,
          error.message
        );
      }
    }

    appLogger.info('Batch completed: {SuccessCount} success, {FailedCount} failed', success, failed);
    return { success, failed, results };
  }

  /**
   * Backward-compatible wrapper.
   * Prefer createManySkoleskyssSequentially for new code.
   */
  public async createBatchSkoleskyss(requests: PostSkoleskyssRequest[]): ReturnType<EnturApiService['createManySkoleskyssSequentially']> {
    return this.createManySkoleskyssSequentially(requests);
  }

  /**
   * Helper function to create skoleskyss request from student data
   */
  public createSkoleskyssRequest(studentData: {
    studentId: string | number;
    applicationId: string | number;
    organisationId?: number; // Default to 27 for Farte if not provided (Not needed, EnTur got this)
    firstName?: string;
    surname?: string;
    schoolId?: string | number;
    schoolName?: string;
    classId?: string | number;
    className?: string;
    email?: string;
    phoneNumber?: string;
    phoneCountryCode?: string;
    startDate: string;
    endDate: string;
    zones: Array<
      | { fromZoneId: string; toZoneId: string; }
      | { groupOfTariffZoneId: string; } // ZoneId for alle soner: TEL:GroupOfTariffZones:1
    >;
  }): PostSkoleskyssRequest {
    // Parse phone number
    let phoneDetails = undefined;
    if (studentData.phoneNumber) {
      const countryCode = studentData.phoneCountryCode || '+47';
      phoneDetails = {
        number: studentData.phoneNumber,
        countryCode: countryCode
      };
    }

    const studentDetails = (studentData.firstName || studentData.surname || studentData.schoolName || studentData.className || studentData.email || phoneDetails) ? {
      firstName: studentData.firstName,
      surname: studentData.surname,
      school: (studentData.schoolId && studentData.schoolName) ? {
        id: studentData.schoolId,
        name: studentData.schoolName
      } : undefined,
      class: (studentData.classId && studentData.className) ? {
        id: studentData.classId,
        name: studentData.className
      } : undefined,
      email: studentData.email,
      phone: phoneDetails
    } : undefined;

    const sanitizedStudentDetails = this.useMockStudentDetails
      ? createHarryPotterMockStudentDetails(`${studentData.studentId}-${studentData.applicationId}`)
      : studentDetails;

    return {
      organisationId: studentData.organisationId, // Not needed, EnTur got this
      studentId: studentData.studentId,
      applicationId: studentData.applicationId,
      validity: {
        startDate: studentData.startDate, // yyyy-mm-dd
        endDate: studentData.endDate, // yyyy-mm-dd
        zones: studentData.zones
      },
      studentDetails: sanitizedStudentDetails
    };
  }

  /**
   * Validate skoleskyss request before sending
   */
  public validateSkoleskyssRequest(request: PostSkoleskyssRequest): {
    isValid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];
    appLogger.debug('Validating skoleskyss request: {RequestJson}', JSON.stringify(request));
    
    // Validate required fields
    if (!request.studentId) {
      errors.push('studentId is required');
    }
    
    if (!request.applicationId) {
      errors.push('applicationId is required');
    }

    // Validate validity object
    if (!request.validity) {
      errors.push('validity object is required');
    } else {
      if (!request.validity.startDate) {
        errors.push('validity.startDate is required');
      } else if (!/^\d{4}-\d{2}-\d{2}$/.test(request.validity.startDate)) {
        errors.push('validity.startDate must be in YYYY-MM-DD format');
      }
      
      if (!request.validity.endDate) {
        errors.push('validity.endDate is required');
      } else if (!/^\d{4}-\d{2}-\d{2}$/.test(request.validity.endDate)) {
        errors.push('validity.endDate must be in YYYY-MM-DD format');
      }

      if (!request.validity.zones || request.validity.zones.length === 0) {
        errors.push('validity.zones must contain at least one zone configuration');
      } else {
        request.validity.zones.forEach((zone, index) => {
          if ('fromZoneId' in zone && 'toZoneId' in zone) {
            if (!zone.fromZoneId || !zone.toZoneId) {
              errors.push(`Zone ${index}: fromZoneId and toZoneId are required when using zone-to-zone format`);
            }
          } else if ('groupOfTariffZoneId' in zone) {
            if (!zone.groupOfTariffZoneId) {
              errors.push(`Zone ${index}: groupOfTariffZoneId is required when using group format`);
            }
          } else {
            errors.push(`Zone ${index}: must specify either fromZoneId/toZoneId or groupOfTariffZoneId`);
          }
        });
      }
    }

    // Validate optional phone number format if provided
    if (request.studentDetails?.phone?.number) {
      const phoneNumber = request.studentDetails.phone.number;
      if (!/^\+?\d+$/.test(phoneNumber.replace(/\s|-/g, ''))) {
        errors.push('studentDetails.phone.number must contain only digits, spaces, hyphens, and optional + prefix');
      }
    }

    // Validate contact if provided
    if (request.studentDetails?.email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(request.studentDetails.email)) {
        errors.push('studentDetails.email must be a valid email address');
      }
    }

    // Validate date logic
    if (request.validity.startDate && request.validity.endDate) {
      const startDate = new Date(request.validity.startDate);
      const endDate = new Date(request.validity.endDate);
      
      if (startDate > endDate) {
        errors.push('validity.endDate must be after startDate');
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Get token information (for debugging)
   */
  public getTokenInfo() {
    return this.authClient.getTokenInfo();
  }

  /**
   * Force refresh the access token
   */
  public async refreshToken(): Promise<void> {
    return await this.authClient.refreshToken();
  }
}
