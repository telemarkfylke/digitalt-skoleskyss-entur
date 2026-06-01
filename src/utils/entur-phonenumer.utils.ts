import { appLogger } from '../services/logger.service';

// At the moment EnTur only accepts phonenumber in the format of a Norwegian number, so we need to convert it before sending it to EnTur format. This utility function can be used to convert a phonenumber to the correct format. 
// The correct format for EnTur is no area codes, and only 8 digits. (As a string for now)
// If the phonenumber has +47 or 0047 we remove it and return the number. If the phonenumber do not start with +47 or 0047 and is 8 digits long, we assume it is already in the correct format and return it as is. If the phonenumber is in any other format, we return undefined and log a warning.

export function formatPhoneNumberForEntur(phoneNumber: string | null): string | undefined {
  appLogger.debug('Formatting phone number for EnTur: {PhoneNumber}', phoneNumber);
  appLogger.debug('Phone number type: {PhoneType}', typeof phoneNumber);
  if (!phoneNumber) {
    return undefined;
  }

  // Remove +47 or 0047 if present
  if (phoneNumber.startsWith('+47')) {
    phoneNumber = phoneNumber.slice(3);
  } else if (phoneNumber.startsWith('0047')) {
    phoneNumber = phoneNumber.slice(4);
  }

  // Check if the phone number is 8 digits long
  if (/^\d{8}$/.test(phoneNumber)) {
    return phoneNumber;
  }

  appLogger.warn('Invalid phone number format: {PhoneNumber}', phoneNumber);
  return undefined;
}
