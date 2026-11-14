import { romanizedName } from '../../src/realestate/place-lookup.js';

/**
 * The boards' own words, with English beside them (Phase 16C). hr.ge states
 * its fields, levels and terms in Georgian; a chip shows the Georgian with
 * the English after it, as the approved mockup does. A word missing here
 * shows as the board wrote it: never a guessed translation, except a place's
 * name, which falls back to its Latin spelling.
 */

const pairs = (list: readonly (readonly [string, string])[]) => new Map(list);

export const CITY_EN = pairs([
  ['თბილისი', 'Tbilisi'],
  ['ბათუმი', 'Batumi'],
  ['ქუთაისი', 'Kutaisi'],
  ['რუსთავი', 'Rustavi'],
  ['მცხეთა', 'Mtskheta'],
  ['ნატახტარი', 'Natakhtari'],
  ['გარდაბანი', 'Gardabani'],
  ['მარნეული', 'Marneuli'],
  ['საზღვარგარეთ', 'Abroad'],
  ['თბილისის შემოგარენი', 'Around Tbilisi'],
  ['თელავი', 'Telavi'],
  ['დუშეთი', 'Dusheti'],
  ['ამბროლაური', 'Ambrolauri'],
  ['ქედის მუნიციპალიტეტი', 'Keda'],
  ['წალენჯიხა', 'Tsalenjikha'],
  ['ბორჯომი', 'Borjomi'],
  ['ბაკურიანი', 'Bakuriani'],
  ['ახალციხე', 'Akhaltsikhe'],
  ['ხაშური', 'Khashuri'],
  ['ქარელი', 'Kareli'],
  ['კასპი', 'Kaspi'],
  ['ახალქალაქი', 'Akhalkalaki'],
  ['ხელვაჩაური', 'Khelvachauri'],
  ['სამტრედია', 'Samtredia'],
  ['საქართველოს მაშტაბით', 'All of Georgia'],
  ['საქართველო', 'Georgia'],
  ['ფოთი', 'Poti'],
  ['გორი', 'Gori'],
  ['ზუგდიდი', 'Zugdidi'],
  ['ზესტაფონი', 'Zestaponi'],
  ['ოზურგეთი', 'Ozurgeti'],
  ['სიღნაღი', 'Sighnaghi'],
  ['ქობულეთი', 'Kobuleti'],
]);

export const FIELD_EN = pairs([
  ['გაყიდვები', 'Sales'],
  ['სამედიცინო', 'Medicine'],
  ['საბანკო', 'Banking'],
  ['ადმინისტრაცია / ბიზნესის მართვა', 'Administration, management'],
  ['სასტუმრო / რესტორანი / კვება', 'Hotels, restaurants, food'],
  ['ტენდერი/კონკურსი', 'Tenders, contests'],
  ['ლოგისტიკა / ტრანსპორტი', 'Logistics, transport'],
  ['მეცნიერება / განათლება', 'Science, education'],
  ['ბუღალტერია / ფინანსები', 'Accounting, finance'],
  ['წარმოება/ოპერაციები', 'Production, operations'],
  ['დაზღვევა', 'Insurance'],
  ['მარკეტინგი/ საზოგადოებასთან ურთიერთობა (PR)', 'Marketing, PR'],
  ['შეკეთება / მონტაჟი', 'Repair, installation'],
  ['ინფორმაციული ტექნოლოგიები', 'IT'],
  ['დასუფთავება', 'Cleaning'],
  ['შეფასება/ექსპერტიზა', 'Valuation, expertise'],
  ['შესყიდვები', 'Procurement'],
  ['უსაფრთხოება / დაცვა', 'Security'],
  ['კაზინო / აზარტული თამაშები', 'Casino, gaming'],
  ['არასამთავრობო (NGO)', 'NGO'],
  ['ხარისხის კონტროლი / გარემოს დაცვა / შრომის უსაფრთხოება', 'Quality, environment, safety'],
  ['ადამიანური რესურსები', 'Human resources'],
  ['ხელოვნება / მედია', 'Arts, media'],
  ['ტურიზმი/გართობა', 'Tourism, leisure'],
  ['ტრენინგ-კურსები/სასწავლო პროგრამები', 'Training courses'],
  ['სამშენებლო', 'Construction'],
  ['იურიდიული', 'Legal'],
  ['სხვა', 'Other'],
  ['ენერგეტიკა', 'Energy'],
]);

export const INDUSTRY_EN = pairs([
  ['ფინანსები', 'Finance'],
  ['საცალო ვაჭრობა', 'Retail'],
  ['ჯანდაცვა', 'Healthcare'],
  ['დასვენება და მოგზაურობა', 'Leisure and travel'],
  ['ტრანსპორტი, ლოჯისტიკა & მიწოდების ჯაჭვი', 'Transport and logistics'],
  ['წარმოება', 'Manufacturing'],
  ['სამომხმარებლო პროდუქტები და სერვისები', 'Consumer goods'],
  ['განათლება', 'Education'],
  ['მშენებლობა', 'Construction'],
  ['არაკომერციული', 'Non-profit'],
  ['უძრავი ქონება', 'Real estate'],
  ['კორპორატიული სერვისები', 'Business services'],
  ['პროგრამული უზრუნველყოფა და IT სერვისები', 'Software and IT'],
  ['საზოგადოებრივი უსაფრთხოება', 'Public safety'],
  ['ტექნიკა და ქსელები', 'Hardware and networks'],
  ['იურიდიული', 'Legal'],
  ['გასართობი', 'Entertainment'],
  ['მედია და კომუნიკაციები', 'Media'],
  ['ველნესი და ფიტნესი', 'Wellness and fitness'],
]);

/** Ordered lists: a chip row reads in the board's own order, not by count. */
export const SENIORITY: readonly (readonly [string, string])[] = [
  ['საწყისი რგოლი', 'Entry level'],
  ['საშუალო რგოლი', 'Mid level'],
  ['უფროსი რგოლი', 'Senior'],
  ['დირექტორი', 'Director'],
  ['აღმასრულებელი რგოლი', 'Executive'],
];
export const EDUCATION: readonly (readonly [string, string])[] = [
  ['არასრული საშუალო განათლება', 'Some secondary school'],
  ['საშუალო განათლება', 'Secondary school'],
  ['პროფესიული კოლეჯი', 'Vocational college'],
  ['ბაკალავრი', "Bachelor's"],
  ['მაგისტრი', "Master's"],
  ['დოქტორი', 'Doctorate'],
];
export const LANGUAGES: readonly (readonly [string, string])[] = [
  ['ქართული', 'Georgian'],
  ['ინგლისური', 'English'],
  ['რუსული', 'Russian'],
  ['გერმანული', 'German'],
  ['თურქული', 'Turkish'],
  ['ფრანგული', 'French'],
  ['იტალიური', 'Italian'],
  ['ესპანური', 'Spanish'],
  ['ჩინური', 'Chinese'],
  ['სომხური', 'Armenian'],
  ['აზერბაიჯანული', 'Azerbaijani'],
  ['უკრაინული', 'Ukrainian'],
  ['არაბული', 'Arabic'],
  ['ებრაული', 'Hebrew'],
  ['ბერძნული', 'Greek'],
  ['პოლონური', 'Polish'],
  ['იაპონური', 'Japanese'],
  ['კორეული', 'Korean'],
  ['სპარსული', 'Persian'],
];
export const WORKPLACE: readonly (readonly [string, string])[] = [
  ['ოფისიდან/სამუშაო ადგილიდან', 'On site'],
  ['ჰიბრიდული/შერეული', 'Hybrid'],
  ['სამუშაო სახლიდან', 'From home'],
  ['საველე', 'In the field'],
];
export const HOURS: readonly (readonly [string, string])[] = [
  ['სრული განაკვეთი', 'Full time'],
  ['ნაწილობრივი განაკვეთი', 'Part time'],
  ['თავისუფალი გრაფიკი - მოქნილი საათები', 'Flexible hours'],
  ['სმენური გრაფიკი – შერეული ცვლები', 'Shifts'],
  ['სმენური გრაფიკი – დღის ცვლა', 'Day shifts'],
  ['სმენური გრაფიკი – ღამის ცვლა', 'Night shifts'],
];
export const CONTRACT: readonly (readonly [string, string])[] = [
  ['ვადიანი კონტრაქტი', 'Fixed-term contract'],
  ['ღია კონტრაქტი', 'Open-ended contract'],
  ['დროებითი', 'Temporary'],
  ['სტაჟირება', 'Internship'],
  ['სტაჟირება შემდგომი დასაქმების პერსპექტივით', 'Internship, then a job'],
  ['ფრილანსი', 'Freelance'],
  ['სეზონური', 'Seasonal'],
  ['პროექტი', 'Project'],
  ['მოხალისეობა', 'Volunteering'],
  ['ერთჯერადი', 'One-off'],
];
export const BENEFITS: readonly (readonly [string, string])[] = [
  ['ჯანმრთელობის დაზღვევა', 'Health insurance'],
  ['ფიტნესი და გამაჯანსაღებელი პროგრამები', 'Fitness'],
  ['უფასო კვება', 'Free meals'],
  ['ტრანსპორტირების უზრუნველყოფა', 'Transport'],
  ['ტრენინგები და პროფესიული ზრდის შესაძლებლობა', 'Training'],
  ['ფასდაკლებები ჩვენს ან პარტნიორ კომპანიებში', 'Staff discounts'],
  ['ანაზღაურებადი დეკრეტული შვებულება', 'Paid parental leave'],
  ['კორპორატიული მობილური პაკეტი', 'Phone plan'],
  ['სიცოცხლის დაზღვევა', 'Life insurance'],
  ['საწვავის ხარჯების ანაზღაურება', 'Fuel paid'],
  ['კარიერული განვითარების ქოუჩინგი', 'Career coaching'],
  ['სამგზავრო ბარათი', 'Travel card'],
  ['ბონუსები და წახალისება', 'Bonuses'],
];
export const METHOD: readonly (readonly [string, string])[] = [
  ['განცხადება', 'Notice'],
  ['ტენდერი ერთი კონვერტის პრინციპით', 'One-envelope tender'],
  ['2 კონვერტის პრინციპი', 'Two-envelope tender'],
  ['პრეკვალიფიკაცია', 'Prequalification'],
  ['რევერსული აუქციონი', 'Reverse auction'],
];

/** CPV 2008's divisions (the code's first two digits), shortened. */
export const CPV_DIVISION_EN = pairs([
  ['03', 'Farming and food produce'],
  ['09', 'Fuel and energy'],
  ['14', 'Mining and metals'],
  ['15', 'Food and drink'],
  ['16', 'Farm machinery'],
  ['18', 'Clothing and footwear'],
  ['19', 'Leather and textiles'],
  ['22', 'Printed matter'],
  ['24', 'Chemicals'],
  ['30', 'Computers and office machines'],
  ['31', 'Electrical equipment'],
  ['32', 'Radio, TV and telecoms equipment'],
  ['33', 'Medical equipment and medicines'],
  ['34', 'Vehicles and transport equipment'],
  ['35', 'Security and defence equipment'],
  ['37', 'Musical, sport and toys'],
  ['38', 'Lab and precision equipment'],
  ['39', 'Furniture and household'],
  ['41', 'Water'],
  ['42', 'Industrial machinery'],
  ['43', 'Mining and building machinery'],
  ['44', 'Building materials'],
  ['45', 'Construction work'],
  ['48', 'Software'],
  ['50', 'Repair and maintenance'],
  ['51', 'Installation'],
  ['55', 'Hotels, catering and retail'],
  ['60', 'Transport services'],
  ['63', 'Transport support and travel'],
  ['64', 'Post and telecoms'],
  ['65', 'Utilities'],
  ['66', 'Finance and insurance'],
  ['70', 'Real estate services'],
  ['71', 'Architecture and engineering'],
  ['72', 'IT services'],
  ['73', 'Research and development'],
  ['75', 'Public administration'],
  ['76', 'Oil and gas services'],
  ['77', 'Farming and forestry services'],
  ['79', 'Business services'],
  ['80', 'Education and training'],
  ['85', 'Health and social work'],
  ['90', 'Cleaning, waste and environment'],
  ['92', 'Recreation, culture and sport'],
  ['98', 'Other services'],
]);

const ordered = (list: readonly (readonly [string, string])[]) => new Map(list);
const SENIORITY_EN = ordered(SENIORITY);
const EDUCATION_EN = ordered(EDUCATION);
const LANGUAGE_EN = ordered(LANGUAGES);
const WORKPLACE_EN = ordered(WORKPLACE);
const HOURS_EN = ordered(HOURS);
const CONTRACT_EN = ordered(CONTRACT);
const BENEFIT_EN = ordered(BENEFITS);
const METHOD_EN = ordered(METHOD);

/** Each list filter's vocabulary: its English, and its own order where it has one. */
export const VOCAB: Readonly<Record<string, ReadonlyMap<string, string>>> = {
  sen: SENIORITY_EN,
  edu: EDUCATION_EN,
  lang: LANGUAGE_EN,
  wf: WORKPLACE_EN,
  sched: HOURS_EN,
  emp: CONTRACT_EN,
  ben: BENEFIT_EN,
  method: METHOD_EN,
  ind: INDUSTRY_EN,
};
export const ORDERED_KEYS: ReadonlySet<string> = new Set([
  'sen',
  'edu',
  'lang',
  'wf',
  'sched',
  'emp',
  'ben',
  'method',
]);

export const SOURCE_NAMES: Readonly<Record<string, string>> = {
  'jobs-ge': 'jobs.ge',
  'hr-ge': 'hr.ge',
  'etenders-ge': 'etenders.ge',
  'summerschoolsineurope-eu': 'summerschoolsineurope.eu',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (m: string) =>
  `${MONTHS[Number(m.slice(5, 7)) - 1] ?? ''} ${m.slice(0, 4)}`;

/** A Georgian place's English: the list above, else its Latin spelling. */
export function cityEnglish(city: string): string {
  return CITY_EN.get(city) ?? romanizedName(city);
}

/** What a place value reads as, in the board's words and English. */
export function placeLabel(value: string): { ka: string; en: string } {
  const name = value.slice(2);
  return value.startsWith('g:') ? { ka: name, en: cityEnglish(name) } : { ka: name, en: name };
}

/** What a field value reads as. */
export function fieldLabel(value: string): { ka: string; en: string } {
  const name = value.slice(2);
  if (value.startsWith('j:')) return { ka: name, en: FIELD_EN.get(name) ?? '' };
  if (value.startsWith('t:')) {
    const en = CPV_DIVISION_EN.get(name) ?? `CPV ${name}`;
    return { ka: en, en: '' };
  }
  return { ka: name, en: '' };
}
