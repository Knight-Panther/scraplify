/**
 * Curated English↔Georgian aliases for browser CV matching (Phase 8D,
 * `lexical-rank-v1`).
 *
 * Why this exists: every title and taxonomy label in the bundle comes from
 * jobs.ge/hr.ge and is overwhelmingly Georgian, while many CVs are written in
 * English. Without a bridge, an English CV saying "accountant" could never
 * meet a listing titled ბუღალტერი. Georgian CVs mostly need none of this:
 * `vocabulary.ts` derives Georgian roles, fields and locations from the
 * bundle itself.
 *
 * This is a MATCHING lexicon, not data: it never renders as a listing,
 * employer or claim. An entry only turns into a profile suggestion when one
 * of its forms occurs in the CV (and the suggestion then quotes that local
 * text), or when the user types it. Every form is matched as whole stemmed
 * tokens (see `text.ts`), so short forms like "qa" or "sql" cannot fire
 * inside ordinary words.
 *
 * Keep entries to terms the corpus actually uses (checked against the
 * active bundle's titles and labels on 2026-09-25) and to unambiguous
 * skills. `generic` marks a broad role that is suppressed when a more
 * specific detected role already contains it ("manager" under "sales
 * manager").
 */

export type LexiconKind = 'role' | 'skill' | 'location';

export interface LexiconEntry {
  kind: LexiconKind;
  /** Stable key: the English label, lowercased. */
  key: string;
  en: string;
  ka: string;
  /** Surface forms in either language. `en` and `ka` are always included too. */
  forms: readonly string[];
  generic?: boolean;
}

type Row = [en: string, ka: string, forms: readonly string[], generic?: true];

const ROLES: readonly Row[] = [
  ['Accountant', 'ბუღალტერი', ['bookkeeper', 'accounting', 'ბუღალტრის', 'ბუღალტრად', 'ბუღალტერია']],
  ['Chief accountant', 'მთავარი ბუღალტერი', ['chief accountant', 'მთავარი ბუღალტრის']],
  ['Financial analyst', 'ფინანსური ანალიტიკოსი', ['finance analyst']],
  ['Analyst', 'ანალიტიკოსი', [], true],
  ['Data analyst', 'მონაცემთა ანალიტიკოსი', ['data analytics', 'bi analyst']],
  ['Auditor', 'აუდიტორი', ['audit', 'აუდიტი', 'აუდიტის']],
  ['Economist', 'ეკონომისტი', []],
  [
    'Software developer',
    'პროგრამისტი',
    ['developer', 'software engineer', 'programmer', 'დეველოპერი', 'პროგრამული უზრუნველყოფის'],
  ],
  ['Frontend developer', 'ფრონტენდ დეველოპერი', ['frontend', 'front end']],
  ['Backend developer', 'ბექენდ დეველოპერი', ['backend', 'back end']],
  ['QA engineer', 'ტესტერი', ['qa', 'tester', 'quality assurance', 'software testing']],
  [
    'System administrator',
    'სისტემური ადმინისტრატორი',
    ['sysadmin', 'system administrator', 'it support', 'helpdesk'],
  ],
  [
    'Designer',
    'დიზაინერი',
    ['graphic designer', 'ui designer', 'ux designer', 'გრაფიკული დიზაინერი'],
  ],
  ['Project manager', 'პროექტის მენეჯერი', ['project management', 'პროექტების მენეჯერი']],
  ['Product manager', 'პროდუქტის მენეჯერი', []],
  ['Sales manager', 'გაყიდვების მენეჯერი', ['sales management', 'account manager']],
  [
    'Sales consultant',
    'გაყიდვების კონსულტანტი',
    [
      'sales assistant',
      'sales associate',
      'shop assistant',
      'კონსულტანტი',
      'გამყიდველი',
      'გამყიდველ კონსულტანტი',
    ],
  ],
  [
    'Sales representative',
    'გაყიდვების წარმომადგენელი',
    ['sales representative', 'sales agent', 'სავაჭრო წარმომადგენელი'],
  ],
  ['Cashier', 'მოლარე', ['cashier', 'მოლარე-კონსულტანტი', 'მოლარე-ოპერატორი']],
  ['Merchandiser', 'მერჩენდაიზერი', []],
  [
    'Marketing manager',
    'მარკეტინგის მენეჯერი',
    ['marketing', 'marketer', 'მარკეტინგი', 'მარკეტოლოგი'],
  ],
  ['SMM specialist', 'SMM მენეჯერი', ['smm', 'social media']],
  [
    'HR manager',
    'HR მენეჯერი',
    ['hr', 'human resources', 'recruiter', 'recruitment', 'ადამიანური რესურსების', 'რეკრუტერი'],
  ],
  ['Lawyer', 'იურისტი', ['legal counsel', 'attorney', 'ადვოკატი']],
  ['Doctor', 'ექიმი', ['physician']],
  ['Nurse', 'ექთანი', []],
  ['Pharmacist', 'ფარმაცევტი', []],
  ['Medical representative', 'სამედიცინო წარმომადგენელი', []],
  ['Teacher', 'მასწავლებელი', ['tutor', 'პედაგოგი']],
  ['Driver', 'მძღოლი', ['მძღოლ-ექსპედიტორი']],
  ['Courier', 'კურიერი', ['delivery']],
  ['Cook', 'მზარეული', ['chef', 'შეფ-მზარეული']],
  ['Baker', 'მცხობელი', ['pastry']],
  ['Waiter', 'მიმტანი', ['waitress', 'ოფიციანტი']],
  ['Bartender', 'ბარმენი', []],
  ['Barista', 'ბარისტა', []],
  ['Cleaner', 'დამლაგებელი', ['cleaning']],
  ['Housekeeper', 'დიასახლისი', ['housekeeping', 'ჰაუსქიფინგი']],
  ['Security guard', 'დაცვის თანამშრომელი', ['security officer', 'დაცვის']],
  ['Engineer', 'ინჟინერი', [], true],
  ['Electrician', 'ელექტრიკოსი', []],
  ['Mechanic', 'მექანიკოსი', []],
  ['Call center operator', 'ქოლ-ცენტრის ოპერატორი', ['call center', 'call centre', 'ქოლ-ცენტრი']],
  ['Operator', 'ოპერატორი', [], true],
  [
    'Customer service',
    'კლიენტთა მომსახურება',
    ['customer support', 'client service', 'მომხმარებელთა მომსახურება'],
  ],
  ['Administrator', 'ადმინისტრატორი', ['office administrator']],
  ['Office manager', 'ოფისის მენეჯერი', ['office management']],
  ['Receptionist', 'რეგისტრატორი', ['reception', 'front desk', 'რესეფშენი', 'რეგისტრატურა']],
  ['Assistant', 'ასისტენტი', [], true],
  ['Translator', 'თარჯიმანი', ['interpreter', 'translation']],
  ['Logistics specialist', 'ლოგისტიკოსი', ['logistics', 'logistician', 'ლოგისტიკა']],
  [
    'Warehouse worker',
    'საწყობის თანამშრომელი',
    ['warehouse', 'storekeeper', 'საწყობი', 'მესაწყობე'],
  ],
  ['Loader', 'მტვირთავი', []],
  ['Distributor', 'დისტრიბუტორი', ['distribution']],
  [
    'Credit officer',
    'კრედიტ ოფიცერი',
    ['loan officer', 'credit officer', 'საკრედიტო ოფიცერი', 'საკრედიტო ექსპერტი'],
  ],
  ['Banker', 'ბანკირი', ['banking', 'bank teller']],
  ['Real estate agent', 'უძრავი ქონების აგენტი', ['realtor', 'real estate']],
  ['Journalist', 'ჟურნალისტი', ['reporter']],
  ['Architect', 'არქიტექტორი', []],
  ['Branch manager', 'ფილიალის მენეჯერი', []],
  ['Manager', 'მენეჯერი', [], true],
  ['Director', 'დირექტორი', ['head of', 'ხელმძღვანელი'], true],
  ['Intern', 'სტაჟიორი', ['internship', 'trainee', 'სტაჟირება']],
];

const SKILLS: readonly Row[] = [
  ['Excel', 'ექსელი', ['ms excel', 'microsoft excel']],
  ['Microsoft Office', 'MS Office', ['ms office', 'microsoft office']],
  ['SQL', 'SQL', ['mysql', 'postgresql', 'postgres', 'ms sql']],
  ['Python', 'Python', []],
  ['JavaScript', 'JavaScript', ['typescript']],
  ['Java', 'Java', []],
  ['C#', 'C#', ['asp net', 'dotnet']],
  ['C++', 'C++', []],
  ['PHP', 'PHP', ['laravel']],
  ['React', 'React', ['react js', 'reactjs', 'next js']],
  ['Node.js', 'Node.js', ['node js', 'nodejs']],
  ['HTML/CSS', 'HTML/CSS', ['html', 'css']],
  ['Git', 'Git', ['github', 'gitlab']],
  ['Docker', 'Docker', ['kubernetes']],
  ['AWS', 'AWS', ['amazon web services']],
  ['Azure', 'Azure', []],
  ['Linux', 'Linux', []],
  ['AutoCAD', 'AutoCAD', []],
  ['Photoshop', 'Photoshop', ['adobe photoshop']],
  ['Illustrator', 'Illustrator', ['adobe illustrator']],
  ['Figma', 'Figma', []],
  ['1C', '1C', ['1ს']],
  ['SAP', 'SAP', []],
  ['Oracle', 'Oracle', []],
  ['Power BI', 'Power BI', ['powerbi']],
  ['Tableau', 'Tableau', []],
  ['Google Analytics', 'Google Analytics', []],
  ['SEO', 'SEO', []],
  // No Georgian form: the abbreviation ფასს stems to ფას and collides with ფასი (price).
  ['IFRS', 'IFRS', ['ifrs']],
  [
    'Driving licence',
    'მართვის მოწმობა',
    ['driving license', 'driver license', "driver's license", 'მართვის მოწმობის'],
  ],
];

const LOCATIONS: readonly Row[] = [
  ['Tbilisi', 'თბილისი', []],
  ['Batumi', 'ბათუმი', []],
  ['Kutaisi', 'ქუთაისი', []],
  ['Rustavi', 'რუსთავი', []],
  ['Marneuli', 'მარნეული', []],
  ['Mtskheta', 'მცხეთა', []],
  ['Gori', 'გორი', []],
  ['Poti', 'ფოთი', []],
  ['Zugdidi', 'ზუგდიდი', []],
  ['Zestaponi', 'ზესტაფონი', []],
  ['Telavi', 'თელავი', []],
  ['Ozurgeti', 'ოზურგეთი', []],
  ['Kobuleti', 'ქობულეთი', []],
  ['Samtredia', 'სამტრედია', []],
  ['Tskaltubo', 'წყალტუბო', []],
  ['Gardabani', 'გარდაბანი', []],
  ['Akhaltsikhe', 'ახალციხე', []],
  ['Khashuri', 'ხაშური', []],
  ['Borjomi', 'ბორჯომი', []],
  ['Senaki', 'სენაკი', []],
  ['Abroad', 'საზღვარგარეთ', ['abroad', 'overseas']],
];

function toEntries(kind: LexiconKind, rows: readonly Row[]): LexiconEntry[] {
  return rows.map(([en, ka, forms, generic]) => ({
    kind,
    key: en.toLowerCase(),
    en,
    ka,
    forms: [en, ka, ...forms],
    ...(generic ? { generic: true } : {}),
  }));
}

export const LEXICON: readonly LexiconEntry[] = [
  ...toEntries('role', ROLES),
  ...toEntries('skill', SKILLS),
  ...toEntries('location', LOCATIONS),
];
