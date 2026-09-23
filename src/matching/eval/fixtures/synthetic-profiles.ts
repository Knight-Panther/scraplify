/**
 * Phase 8A evaluation corpus (change.md §12's "15+ representative
 * synthetic/properly anonymized Georgian, English and mixed-language
 * profiles"). Every entry here is entirely invented for this evaluation: no
 * name, employer, or life detail traceable to a real person. Deliberately
 * written without a personal name at all — role, skills, experience and
 * location are what CV-to-listing matching actually judges, and omitting a
 * name removes any question of resemblance to someone real.
 *
 * `language` records what the profile text itself is written in, not a
 * claimed proficiency, so a later evaluation run can break results out by
 * language and catch a model that only works well in English.
 */

export interface SyntheticProfile {
  id: string;
  language: 'ka' | 'en' | 'mixed';
  /** Role/seniority this profile represents, for grouping results later. */
  summary: string;
  text: string;
}

export const SYNTHETIC_PROFILES: readonly SyntheticProfile[] = [
  {
    id: 'synthetic-01',
    language: 'en',
    summary: 'Junior accountant, Tbilisi',
    text: 'Junior accountant with 1.5 years of experience in accounts payable and VAT reporting for a small retail company in Tbilisi. Proficient in 1C and Excel. Looking for a full-time position with room to grow into a senior accountant role. Fluent in Georgian and English.',
  },
  {
    id: 'synthetic-02',
    language: 'ka',
    summary: 'Senior accountant, Tbilisi',
    text: 'ბუღალტერი, 8 წლიანი გამოცდილებით საწარმოო კომპანიაში. სრული ციკლის ბუღალტრული აღრიცხვა, საგადასახადო დეკლარაციები, ხელფასების დარიცხვა. მუშაობის გამოცდილება 1C და Oris-ში. ვეძებ სამუშაოს თბილისში, სრული განაკვეთით.',
  },
  {
    id: 'synthetic-03',
    language: 'en',
    summary: 'Mid-level backend developer, remote',
    text: 'Backend developer with 4 years of experience building REST APIs in Node.js and TypeScript, PostgreSQL, and Docker. Contributed to a mid-sized e-commerce platform. Comfortable working fully remote for a Georgia-based or international company. Intermediate English, native Georgian.',
  },
  {
    id: 'synthetic-04',
    language: 'mixed',
    summary: 'Frontend developer, Tbilisi',
    text: 'Frontend დეველოპერი, 3 წლიანი გამოცდილება React-ში და TypeScript-ში. Built and maintained dashboards for a fintech startup. Familiar with Tailwind CSS and Next.js. მუშაობის გამოცდილება agile გუნდში. Looking for on-site or hybrid work in Tbilisi.',
  },
  {
    id: 'synthetic-05',
    language: 'en',
    summary: 'Entry-level QA engineer',
    text: 'Recent university graduate in computer science, completed a manual QA testing course. No professional experience yet, but built a personal test plan and bug-tracking portfolio project. Eager to start as a junior QA engineer, based in Kutaisi, open to relocation.',
  },
  {
    id: 'synthetic-06',
    language: 'ka',
    summary: 'Marketing specialist, Batumi',
    text: 'მარკეტინგის სპეციალისტი, 3 წლიანი გამოცდილება სოციალურ ქსელებში კონტენტის მართვასა და სარეკლამო კამპანიების წარმოებაში. მუშაობდა სასტუმროების ჯაჭვისთვის ბათუმში. ვფლობ Meta Ads Manager-ს და Canva-ს. ვეძებ სამუშაოს ბათუმში ან დისტანციურად.',
  },
  {
    id: 'synthetic-07',
    language: 'en',
    summary: 'Sales manager, B2B, Tbilisi',
    text: 'B2B sales manager with 6 years of experience in the FMCG sector, managing a team of 4 sales representatives and a portfolio of retail chain clients in Tbilisi. Strong negotiation and CRM skills (Salesforce). Seeking a senior sales or commercial manager role.',
  },
  {
    id: 'synthetic-08',
    language: 'ka',
    summary: 'Driver, category B/C, Tbilisi',
    text: 'მძღოლი, B და C კატეგორიის მართვის მოწმობა, 10 წლიანი გამოცდილება ტვირთების გადაზიდვაში თბილისში და რეგიონებში. სუფთა ნასამართლეობა. ვეძებ სამუშაოს კურიერად ან საწარმოში მძღოლად.',
  },
  {
    id: 'synthetic-09',
    language: 'en',
    summary: 'English teacher, Tbilisi',
    text: 'Certified English language teacher (CELTA) with 5 years of experience teaching secondary school students and adult learners in Tbilisi. Comfortable preparing students for IELTS. Looking for a part-time or full-time teaching position.',
  },
  {
    id: 'synthetic-10',
    language: 'mixed',
    summary: 'HR generalist, Tbilisi',
    text: 'HR გენერალისტი, 4 წლიანი გამოცდილება რეკრუტმენტში, ონბორდინგსა და HR დოკუმენტბრუნვაში საშუალო ზომის კომპანიაში. Experience with BambooHR and local labor law compliance. Looking for an HR manager position in Tbilisi.',
  },
  {
    id: 'synthetic-11',
    language: 'en',
    summary: 'Registered nurse, Tbilisi',
    text: 'Registered nurse with 7 years of clinical experience in a general hospital in Tbilisi, including 3 years in the emergency department. Certified in basic life support. Seeking a nursing position in a private clinic or hospital.',
  },
  {
    id: 'synthetic-12',
    language: 'ka',
    summary: 'Junior lawyer, Tbilisi',
    text: 'იურისტი, 2 წლიანი გამოცდილება სახელშეკრულებო სამართალში საადვოკატო ბიუროში. ვამზადებ სახელშეკრულებო დოკუმენტაციას და ვახორციელებ იურიდიულ კვლევას. ვეძებ იურისტის პოზიციას კომპანიის იურიდიულ დეპარტამენტში.',
  },
  {
    id: 'synthetic-13',
    language: 'en',
    summary: 'Retail cashier, Batumi',
    text: 'Retail cashier with 2 years of experience at a supermarket chain in Batumi, handling point-of-sale transactions and customer service during the high tourist season. Basic English. Looking for a similar role or a shift supervisor position.',
  },
  {
    id: 'synthetic-14',
    language: 'mixed',
    summary: 'Georgian-English translator, remote',
    text: 'თარჯიმანი ქართულ-ინგლისურ ენებზე, 5 წლიანი გამოცდილება იურიდიული და ტექნიკური დოკუმენტების თარგმანში. Freelance and remote work experience with international clients. Comfortable with CAT tools. ვეძებ დისტანციურ ან ნახევარგანაკვეთიან სამუშაოს.',
  },
  {
    id: 'synthetic-15',
    language: 'en',
    summary: 'Project manager, IT, Tbilisi',
    text: 'IT project manager with 5 years of experience delivering software projects for clients in the fintech and logistics sectors, using Agile/Scrum. PMP-track certification in progress. Based in Tbilisi, open to hybrid work.',
  },
  {
    id: 'synthetic-16',
    language: 'ka',
    summary: 'Warehouse worker, Rustavi',
    text: 'საწყობის თანამშრომელი, 3 წლიანი გამოცდილება საწყობის მართვის სისტემებთან მუშაობასა და ინვენტარიზაციაში მეტალურგიულ საწარმოში რუსთავში. საშტანგო ვაგნის მართვის მოწმობა. ვეძებ სამუშაოს ლოგისტიკურ კომპანიაში.',
  },
  {
    id: 'synthetic-17',
    language: 'en',
    summary: 'UX/UI designer, remote',
    text: 'UX/UI designer with 4 years of experience designing web and mobile interfaces, primarily in Figma. Worked with a Georgian fintech startup and an international remote team. Strong portfolio in dashboard and form-heavy product design. Open to remote or hybrid roles.',
  },
  {
    id: 'synthetic-18',
    language: 'mixed',
    summary: 'Customer support representative, Tbilisi',
    text: 'მომხმარებელთა მხარდაჭერის სპეციალისტი, 2 წლიანი გამოცდილება ტელეკომუნიკაციის კომპანიაში ცხელ ხაზზე მუშაობით. Comfortable with Zendesk and handling both Georgian- and English-speaking customers. Looking for a similar support role, on-site or remote.',
  },
];
