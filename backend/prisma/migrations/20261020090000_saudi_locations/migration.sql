-- Saudi Arabia location master (owner decision 2026-10-03): Job Post (City) is chosen as
-- Region + City from a two-level list that hospital-wide HR and System Admins maintain on screen
-- (Workforce -> Locations). Regions carry their ISO 3166-2 code; each city belongs to exactly one
-- region. Employees store both; the server checks the city belongs to the region. The free text
-- from before stays only where it could not be matched, so HR can choose the right location.

-- CreateTable
CREATE TABLE "saudi_regions" (
    "code" VARCHAR(10) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "name_ar" VARCHAR(80),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "saudi_regions_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "saudi_cities" (
    "id" SERIAL NOT NULL,
    "region_code" VARCHAR(10) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "name_ar" VARCHAR(80),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "saudi_cities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "saudi_regions_name_key" ON "saudi_regions"("name");

-- CreateIndex
CREATE UNIQUE INDEX "saudi_cities_region_code_name_key" ON "saudi_cities"("region_code", "name");

-- AddForeignKey
ALTER TABLE "saudi_cities" ADD CONSTRAINT "saudi_cities_region_code_fkey" FOREIGN KEY ("region_code") REFERENCES "saudi_regions"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The owner's starting list: 13 regions and their cities, in the owner's order.
INSERT INTO "saudi_regions" ("code", "name", "name_ar", "sort_order", "updated_at") VALUES
    ('SA-01', 'Riyadh Region', 'منطقة الرياض', 1, CURRENT_TIMESTAMP),
    ('SA-02', 'Makkah Region', 'منطقة مكة المكرمة', 2, CURRENT_TIMESTAMP),
    ('SA-03', 'Madinah Region', 'منطقة المدينة المنورة', 3, CURRENT_TIMESTAMP),
    ('SA-04', 'Eastern Province', 'المنطقة الشرقية', 4, CURRENT_TIMESTAMP),
    ('SA-05', 'Qassim Region', 'منطقة القصيم', 5, CURRENT_TIMESTAMP),
    ('SA-14', 'Asir Region', 'منطقة عسير', 6, CURRENT_TIMESTAMP),
    ('SA-07', 'Tabuk Region', 'منطقة تبوك', 7, CURRENT_TIMESTAMP),
    ('SA-06', 'Hail Region', 'منطقة حائل', 8, CURRENT_TIMESTAMP),
    ('SA-08', 'Northern Borders Region', 'منطقة الحدود الشمالية', 9, CURRENT_TIMESTAMP),
    ('SA-09', 'Jazan Region', 'منطقة جازان', 10, CURRENT_TIMESTAMP),
    ('SA-10', 'Najran Region', 'منطقة نجران', 11, CURRENT_TIMESTAMP),
    ('SA-11', 'Al-Baha Region', 'منطقة الباحة', 12, CURRENT_TIMESTAMP),
    ('SA-12', 'Al-Jouf Region', 'منطقة الجوف', 13, CURRENT_TIMESTAMP);

INSERT INTO "saudi_cities" ("region_code", "name", "name_ar", "sort_order", "updated_at") VALUES
    ('SA-01', 'Riyadh', 'الرياض', 1, CURRENT_TIMESTAMP),
    ('SA-01', 'Al Kharj', 'الخرج', 2, CURRENT_TIMESTAMP),
    ('SA-01', 'Ad Dilam', 'الدلم', 3, CURRENT_TIMESTAMP),
    ('SA-01', 'Al Dawadmi', 'الدوادمي', 4, CURRENT_TIMESTAMP),
    ('SA-01', 'Al Majma''ah', 'المجمعة', 5, CURRENT_TIMESTAMP),
    ('SA-01', 'Shaqra', 'شقراء', 6, CURRENT_TIMESTAMP),
    ('SA-01', 'Wadi Al-Dawasir', 'وادي الدواسر', 7, CURRENT_TIMESTAMP),
    ('SA-01', 'Afif', 'عفيف', 8, CURRENT_TIMESTAMP),
    ('SA-01', 'Zulfi', 'الزلفي', 9, CURRENT_TIMESTAMP),
    ('SA-01', 'Al Ghat', 'الغاط', 10, CURRENT_TIMESTAMP),
    ('SA-01', 'Diriyah', 'الدرعية', 11, CURRENT_TIMESTAMP),
    ('SA-01', 'Huraymila', 'حريملاء', 12, CURRENT_TIMESTAMP),
    ('SA-01', 'Rumah', 'رماح', 13, CURRENT_TIMESTAMP),
    ('SA-01', 'Thadiq', 'ثادق', 14, CURRENT_TIMESTAMP),
    ('SA-01', 'Hotat Bani Tamim', 'حوطة بني تميم', 15, CURRENT_TIMESTAMP),
    ('SA-01', 'Al Hariq', 'الحريق', 16, CURRENT_TIMESTAMP),
    ('SA-01', 'Layla', 'ليلى', 17, CURRENT_TIMESTAMP),
    ('SA-01', 'Marat', 'مرات', 18, CURRENT_TIMESTAMP),
    ('SA-02', 'Makkah', 'مكة المكرمة', 1, CURRENT_TIMESTAMP),
    ('SA-02', 'Jeddah', 'جدة', 2, CURRENT_TIMESTAMP),
    ('SA-02', 'Taif', 'الطائف', 3, CURRENT_TIMESTAMP),
    ('SA-02', 'Rabigh', 'رابغ', 4, CURRENT_TIMESTAMP),
    ('SA-02', 'Al Lith', 'الليث', 5, CURRENT_TIMESTAMP),
    ('SA-02', 'Al Jumum', 'الجموم', 6, CURRENT_TIMESTAMP),
    ('SA-02', 'Khulais', 'خليص', 7, CURRENT_TIMESTAMP),
    ('SA-02', 'Turabah', 'تربة', 8, CURRENT_TIMESTAMP),
    ('SA-02', 'Ranyah', 'رنية', 9, CURRENT_TIMESTAMP),
    ('SA-02', 'Al Khurmah', 'الخرمة', 10, CURRENT_TIMESTAMP),
    ('SA-03', 'Madinah', 'المدينة المنورة', 1, CURRENT_TIMESTAMP),
    ('SA-03', 'Yanbu', 'ينبع', 2, CURRENT_TIMESTAMP),
    ('SA-03', 'Al Ula', 'العلا', 3, CURRENT_TIMESTAMP),
    ('SA-03', 'Badr', 'بدر', 4, CURRENT_TIMESTAMP),
    ('SA-03', 'Khaybar', 'خيبر', 5, CURRENT_TIMESTAMP),
    ('SA-03', 'Mahd adh Dhahab', 'مهد الذهب', 6, CURRENT_TIMESTAMP),
    ('SA-03', 'Al Hanakiyah', 'الحناكية', 7, CURRENT_TIMESTAMP),
    ('SA-04', 'Dammam', 'الدمام', 1, CURRENT_TIMESTAMP),
    ('SA-04', 'Al Khobar', 'الخبر', 2, CURRENT_TIMESTAMP),
    ('SA-04', 'Dhahran', 'الظهران', 3, CURRENT_TIMESTAMP),
    ('SA-04', 'Al Ahsa / Hofuf', 'الأحساء / الهفوف', 4, CURRENT_TIMESTAMP),
    ('SA-04', 'Al Mubarraz', 'المبرز', 5, CURRENT_TIMESTAMP),
    ('SA-04', 'Qatif', 'القطيف', 6, CURRENT_TIMESTAMP),
    ('SA-04', 'Jubail', 'الجبيل', 7, CURRENT_TIMESTAMP),
    ('SA-04', 'Ras Tanura', 'رأس تنورة', 8, CURRENT_TIMESTAMP),
    ('SA-04', 'Safwa', 'صفوى', 9, CURRENT_TIMESTAMP),
    ('SA-04', 'Saihat', 'سيهات', 10, CURRENT_TIMESTAMP),
    ('SA-04', 'Al Khafji', 'الخفجي', 11, CURRENT_TIMESTAMP),
    ('SA-04', 'Abqaiq', 'بقيق', 12, CURRENT_TIMESTAMP),
    ('SA-05', 'Buraydah', 'بريدة', 1, CURRENT_TIMESTAMP),
    ('SA-05', 'Unaizah', 'عنيزة', 2, CURRENT_TIMESTAMP),
    ('SA-05', 'Ar Rass', 'الرس', 3, CURRENT_TIMESTAMP),
    ('SA-05', 'Al Bukayriyah', 'البكيرية', 4, CURRENT_TIMESTAMP),
    ('SA-05', 'Al Mithnab', 'المذنب', 5, CURRENT_TIMESTAMP),
    ('SA-05', 'Al Badai', 'البدائع', 6, CURRENT_TIMESTAMP),
    ('SA-05', 'Riyadh Al Khabra', 'رياض الخبراء', 7, CURRENT_TIMESTAMP),
    ('SA-05', 'Uyun Al Jawa', 'عيون الجواء', 8, CURRENT_TIMESTAMP),
    ('SA-14', 'Abha', 'أبها', 1, CURRENT_TIMESTAMP),
    ('SA-14', 'Khamis Mushait', 'خميس مشيط', 2, CURRENT_TIMESTAMP),
    ('SA-14', 'Bisha', 'بيشة', 3, CURRENT_TIMESTAMP),
    ('SA-14', 'Muhayil', 'محايل', 4, CURRENT_TIMESTAMP),
    ('SA-14', 'Al Namas', 'النماص', 5, CURRENT_TIMESTAMP),
    ('SA-14', 'Sarat Abidah', 'سراة عبيدة', 6, CURRENT_TIMESTAMP),
    ('SA-14', 'Tanomah', 'تنومة', 7, CURRENT_TIMESTAMP),
    ('SA-14', 'Rijal Alma', 'رجال ألمع', 8, CURRENT_TIMESTAMP),
    ('SA-07', 'Tabuk', 'تبوك', 1, CURRENT_TIMESTAMP),
    ('SA-07', 'Duba', 'ضباء', 2, CURRENT_TIMESTAMP),
    ('SA-07', 'Al Wajh', 'الوجه', 3, CURRENT_TIMESTAMP),
    ('SA-07', 'Umluj', 'أملج', 4, CURRENT_TIMESTAMP),
    ('SA-07', 'Tayma', 'تيماء', 5, CURRENT_TIMESTAMP),
    ('SA-07', 'Haql', 'حقل', 6, CURRENT_TIMESTAMP),
    ('SA-06', 'Hail', 'حائل', 1, CURRENT_TIMESTAMP),
    ('SA-06', 'Baqaa', 'بقعاء', 2, CURRENT_TIMESTAMP),
    ('SA-06', 'Ash Shinan', 'الشنان', 3, CURRENT_TIMESTAMP),
    ('SA-06', 'Al Ghazalah', 'الغزالة', 4, CURRENT_TIMESTAMP),
    ('SA-06', 'Al Hait', 'الحائط', 5, CURRENT_TIMESTAMP),
    ('SA-06', 'Al Shammli', 'الشملي', 6, CURRENT_TIMESTAMP),
    ('SA-06', 'Al Sulaimi', 'السليمي', 7, CURRENT_TIMESTAMP),
    ('SA-06', 'Mawqaq', 'موقق', 8, CURRENT_TIMESTAMP),
    ('SA-08', 'Arar', 'عرعر', 1, CURRENT_TIMESTAMP),
    ('SA-08', 'Rafha', 'رفحاء', 2, CURRENT_TIMESTAMP),
    ('SA-08', 'Turaif', 'طريف', 3, CURRENT_TIMESTAMP),
    ('SA-08', 'Al Uwayqilah', 'العويقيلة', 4, CURRENT_TIMESTAMP),
    ('SA-09', 'Jazan', 'جازان', 1, CURRENT_TIMESTAMP),
    ('SA-09', 'Sabya', 'صبيا', 2, CURRENT_TIMESTAMP),
    ('SA-09', 'Abu Arish', 'أبو عريش', 3, CURRENT_TIMESTAMP),
    ('SA-09', 'Samtah', 'صامطة', 4, CURRENT_TIMESTAMP),
    ('SA-09', 'Baish', 'بيش', 5, CURRENT_TIMESTAMP),
    ('SA-09', 'Farasan', 'فرسان', 6, CURRENT_TIMESTAMP),
    ('SA-09', 'Ahad Al Masarihah', 'أحد المسارحة', 7, CURRENT_TIMESTAMP),
    ('SA-09', 'Damad', 'ضمد', 8, CURRENT_TIMESTAMP),
    ('SA-10', 'Najran', 'نجران', 1, CURRENT_TIMESTAMP),
    ('SA-10', 'Sharurah', 'شرورة', 2, CURRENT_TIMESTAMP),
    ('SA-10', 'Hubuna', 'حبونا', 3, CURRENT_TIMESTAMP),
    ('SA-10', 'Badr Al Janub', 'بدر الجنوب', 4, CURRENT_TIMESTAMP),
    ('SA-10', 'Yadamah', 'يدمة', 5, CURRENT_TIMESTAMP),
    ('SA-10', 'Thar', 'ثار', 6, CURRENT_TIMESTAMP),
    ('SA-10', 'Khubash', 'خباش', 7, CURRENT_TIMESTAMP),
    ('SA-11', 'Al-Baha', 'الباحة', 1, CURRENT_TIMESTAMP),
    ('SA-11', 'Baljurashi', 'بلجرشي', 2, CURRENT_TIMESTAMP),
    ('SA-11', 'Al Mandaq', 'المندق', 3, CURRENT_TIMESTAMP),
    ('SA-11', 'Al Makhwah', 'المخواة', 4, CURRENT_TIMESTAMP),
    ('SA-11', 'Qilwah', 'قلوة', 5, CURRENT_TIMESTAMP),
    ('SA-11', 'Al Aqiq', 'العقيق', 6, CURRENT_TIMESTAMP),
    ('SA-11', 'Al Qura', 'القرى', 7, CURRENT_TIMESTAMP),
    ('SA-11', 'Ghamid Al Zanad', 'غامد الزناد', 8, CURRENT_TIMESTAMP),
    ('SA-12', 'Sakaka', 'سكاكا', 1, CURRENT_TIMESTAMP),
    ('SA-12', 'Qurayyat', 'القريات', 2, CURRENT_TIMESTAMP),
    ('SA-12', 'Dumat Al-Jandal', 'دومة الجندل', 3, CURRENT_TIMESTAMP),
    ('SA-12', 'Tabarjal', 'طبرجل', 4, CURRENT_TIMESTAMP);

-- AlterTable
ALTER TABLE "employees" ADD COLUMN "job_post_region_code" VARCHAR(10),
ADD COLUMN "job_post_city_id" INTEGER;

-- CreateIndex
CREATE INDEX "employees_job_post_region_code_idx" ON "employees"("job_post_region_code");

-- CreateIndex
CREATE INDEX "employees_job_post_city_id_idx" ON "employees"("job_post_city_id");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_job_post_region_code_fkey" FOREIGN KEY ("job_post_region_code") REFERENCES "saudi_regions"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_job_post_city_id_fkey" FOREIGN KEY ("job_post_city_id") REFERENCES "saudi_cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Normalise the free text already recorded: a value that is exactly a listed city (English or
-- Arabic, any case and spacing), or "<region> - <city>", gets the region and city and the text is
-- cleared. Anything else — e.g. "Riyadh - Al Iman Hospital" — is left exactly as it was, with no
-- location, for HR to choose on Edit.
WITH matched AS (
    SELECT e.id, (
        SELECT c.id FROM "saudi_cities" c JOIN "saudi_regions" r ON r.code = c.region_code
         WHERE lower(btrim(e.job_post_location)) IN (lower(c.name), lower(r.name || ' - ' || c.name))
            OR btrim(e.job_post_location) IN (c.name_ar, r.name_ar || ' - ' || c.name_ar)
         ORDER BY c.id LIMIT 1
    ) AS city_id
    FROM "employees" e
    WHERE e.job_post_location IS NOT NULL AND btrim(e.job_post_location) <> ''
)
UPDATE "employees" e SET "job_post_city_id" = m.city_id, "job_post_region_code" = c.region_code, "job_post_location" = NULL
FROM matched m JOIN "saudi_cities" c ON c.id = m.city_id
WHERE e.id = m.id;
