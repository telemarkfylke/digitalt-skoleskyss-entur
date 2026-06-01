export interface EnturMockStudentDetails {
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
}

const HP_FIRST_NAMES = [
  'Harry',
  'Hermione',
  'Ron',
  'Ginny',
  'Luna',
  'Neville',
  'Draco',
  'Cedric',
  'Cho',
  'Fleur'
];

const HP_SURNAMES = [
  'Potter',
  'Granger',
  'Weasley',
  'Lovegood',
  'Longbottom',
  'Malfoy',
  'Diggory',
  'Chang',
  'Delacour',
  'Black'
];

const HOUSE_NAMES = ['Gryffindor', 'Ravenclaw', 'Hufflepuff', 'Slytherin'];

const hashSeed = (seed: string): number => {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
};

const pickByIndex = <T>(items: T[], index: number): T => {
  return items[index % items.length];
};

export const createHarryPotterMockStudentDetails = (
  seed: string | number
): EnturMockStudentDetails => {
  const seedHash = hashSeed(String(seed));
  const firstName = pickByIndex(HP_FIRST_NAMES, seedHash);
  const surname = pickByIndex(HP_SURNAMES, Math.floor(seedHash / 3));
  const house = pickByIndex(HOUSE_NAMES, Math.floor(seedHash / 5));
  const year = (seedHash % 7) + 1;

  return {
    firstName,
    surname,
    school: {
      id: 'hogwarts',
      name: 'Hogwarts School of Witchcraft and Wizardry'
    },
    class: {
      id: `${house.toLowerCase()}-${year}`,
      name: `${house} Year ${year}`
    },
    email: `${firstName.toLowerCase()}.${surname.toLowerCase()}@hogwarts.mock`,
    phone: {
      number: `9${String(seedHash).padStart(7, '0').slice(0, 7)}`,
      countryCode: '+47'
    }
  };
};
