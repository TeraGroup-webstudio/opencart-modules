-- =====================================================================
-- OpenCart 3.0.x / ocStore 3.x — ПРИБИРАННЯ ХВОСТІВ (осиротілих записів)
--
-- Для ситуації: товари/категорії видалили через адмінку, а в описах,
-- таблицях модулів, ЧПУ тощо лишилися рядки зі старими ID.
-- Живі товари, категорії, статті, замовлення НЕ видаляються.
-- В кінці — звіт: яка таблиця, що саме і скільки рядків видалено.
--
-- ⚠️ ПЕРЕД ІМПОРТОМ зробіть бекап: phpMyAdmin → Експорт → Швидкий → SQL.
--
-- Префікс таблиць визначається АВТОМАТИЧНО. Якщо в базі кілька магазинів
-- з різними префіксами — впишіть потрібний у @p_manual нижче.
-- Якщо префікс не визначено, імпорт зупиниться і НІЧОГО не буде видалено.
--
-- Імпорт: phpMyAdmin → Імпорт → цей файл → Вперед.
-- =====================================================================

SET @p_manual = '';   -- наприклад 'oc_'; порожньо = автовизначення

SET NAMES utf8mb4;

-- Автовизначення: префікс, для якого існують і product_to_category, і setting, і product
SET @p = NULL;
SELECT IF(COUNT(*) = 1, MIN(c.pfx), NULL) INTO @p
FROM (
  SELECT LEFT(t.TABLE_NAME, CHAR_LENGTH(t.TABLE_NAME) - CHAR_LENGTH('product_to_category')) AS pfx
  FROM information_schema.TABLES t
  WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_NAME LIKE '%product\_to\_category'
) c
WHERE EXISTS (SELECT 1 FROM information_schema.TABLES s
              WHERE s.TABLE_SCHEMA = DATABASE() AND s.TABLE_NAME = CONCAT(c.pfx, 'setting'))
  AND EXISTS (SELECT 1 FROM information_schema.TABLES s
              WHERE s.TABLE_SCHEMA = DATABASE() AND s.TABLE_NAME = CONCAT(c.pfx, 'product'));
SET @p = IF(@p_manual <> '', @p_manual, @p);

DROP PROCEDURE IF EXISTS lp_check_prefix;
DELIMITER $$
CREATE PROCEDURE lp_check_prefix()
BEGIN
  IF @p IS NULL OR NOT EXISTS (SELECT 1 FROM information_schema.TABLES
                               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = CONCAT(@p, 'product')) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Префікс таблиць не визначено: впишіть його в @p_manual (як DB_PREFIX). Нічого не видалено.';
  END IF;
END$$
DELIMITER ;
CALL lp_check_prefix();
DROP PROCEDURE IF EXISTS lp_check_prefix;

SELECT @p AS `префікс таблиць`;

-- =====================================================================
-- OpenCart 3.0.x / ocStore 3.x — очистка «хвостів» (осиротілих записів)
--
-- Для ситуації: товари/категорії видалили через адмінку, а в таблицях
-- модулів, описах, ЧПУ тощо лишилися рядки зі старими ID.
-- Живі товари, категорії, статті НЕ видаляються — лише записи, що
-- посилаються на те, чого вже не існує.
--
-- ⚠️ ПЕРЕД ЗАПУСКОМ зробіть бекап: phpMyAdmin → Експорт → Швидкий → SQL.
--
-- Префікс таблиць задається ОДИН раз нижче (@p) — як DB_PREFIX у config.php.
-- В кінці виводиться звіт: яка таблиця, що саме і скільки рядків видалено.
-- Історія замовлень і повернень (order*, return*) не чіпається ніколи.
-- =====================================================================

-- @p визначено на початку файлу

SET NAMES utf8mb4;

DROP PROCEDURE IF EXISTS lp_exec;
DROP PROCEDURE IF EXISTS lp_orphans;
DROP TEMPORARY TABLE IF EXISTS lp_report;
CREATE TEMPORARY TABLE lp_report (
  tbl VARCHAR(64) NOT NULL,
  what VARCHAR(255) NOT NULL,
  removed INT NOT NULL
) DEFAULT CHARSET=utf8mb4;

DELIMITER $$

-- Виконує запит, якщо існують обидві таблиці (назви БЕЗ префікса; p_need може бути '').
-- У запиті {p} замінюється на префікс. Кількість змінених рядків пишеться у звіт.
CREATE PROCEDURE lp_exec(IN p_table VARCHAR(64) CHARACTER SET utf8mb4, IN p_need VARCHAR(64) CHARACTER SET utf8mb4, IN p_what VARCHAR(255) CHARACTER SET utf8mb4, IN p_sql TEXT CHARACTER SET utf8mb4)
BEGIN
  DECLARE v_rows INT DEFAULT 0;
  IF EXISTS (SELECT 1 FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = CONCAT(@p, p_table))
     AND (p_need = '' OR EXISTS (SELECT 1 FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = CONCAT(@p, p_need))) THEN
    SET @lp_sql = REPLACE(p_sql, '{p}', @p);
    PREPARE lp_stmt FROM @lp_sql;
    EXECUTE lp_stmt;
    SET v_rows = ROW_COUNT();
    DEALLOCATE PREPARE lp_stmt;
    INSERT INTO lp_report VALUES (CONCAT(@p, p_table), p_what, v_rows);
  END IF;
END$$

-- Для КОЖНОЇ таблиці, що має колонку p_col і чия назва (без префікса) підходить
-- під LIKE p_like, але НЕ під REGEXP p_except, видаляє рядки, де p_col <> 0
-- і такого значення немає в p_entity.p_entity_col.
CREATE PROCEDURE lp_orphans(
  IN p_col VARCHAR(64) CHARACTER SET utf8mb4, IN p_entity VARCHAR(64) CHARACTER SET utf8mb4, IN p_entity_col VARCHAR(64) CHARACTER SET utf8mb4,
  IN p_like VARCHAR(64) CHARACTER SET utf8mb4, IN p_except VARCHAR(128) CHARACTER SET utf8mb4
)
BEGIN
  DECLARE v_done INT DEFAULT 0;
  DECLARE v_table VARCHAR(64) CHARACTER SET utf8mb4;
  DECLARE v_rows INT;
  -- Порожній REGEXP падає на MySQL 5.7 / старих MariaDB (#1139), тому
  -- "без винятків" = шаблон, який ніколи не збігається з назвою таблиці
  DECLARE v_except VARCHAR(128) CHARACTER SET utf8mb4 DEFAULT '^#never#$';
  DECLARE cur CURSOR FOR
    SELECT c.TABLE_NAME
    FROM information_schema.COLUMNS c
    JOIN information_schema.TABLES t
      ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_TYPE = 'BASE TABLE'
    WHERE c.TABLE_SCHEMA = DATABASE()
      AND c.COLUMN_NAME = p_col
      AND c.TABLE_NAME LIKE CONCAT(REPLACE(@p, '_', '\\_'), p_like)
      AND c.TABLE_NAME <> CONCAT(@p, p_entity)
      AND c.TABLE_NAME NOT LIKE CONCAT(REPLACE(@p, '_', '\\_'), 'order%')
      AND c.TABLE_NAME NOT LIKE CONCAT(REPLACE(@p, '_', '\\_'), 'return%')
      -- CONVERT: у MySQL 8 information_schema в utf8mb3, а REGEXP вимагає однакове кодування (#3995)
      AND CONVERT(SUBSTRING(c.TABLE_NAME, CHAR_LENGTH(@p) + 1) USING utf8mb4)
          NOT REGEXP CONVERT(v_except USING utf8mb4);
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_done = 1;

  IF p_except <> '' THEN
    SET v_except = p_except;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = CONCAT(@p, p_entity)) THEN
    OPEN cur;
    read_loop: LOOP
      FETCH cur INTO v_table;
      IF v_done THEN
        LEAVE read_loop;
      END IF;
      SET @lp_sql = CONCAT(
        'DELETE x FROM `', v_table, '` x LEFT JOIN `', @p, p_entity, '` e ON e.`', p_entity_col, '` = x.`', p_col, '` ',
        'WHERE x.`', p_col, '` <> 0 AND e.`', p_entity_col, '` IS NULL');
      PREPARE lp_stmt FROM @lp_sql;
      EXECUTE lp_stmt;
      SET v_rows = ROW_COUNT();
      DEALLOCATE PREPARE lp_stmt;
      INSERT INTO lp_report VALUES (v_table, CONCAT(p_col, ' → неіснуючий ', p_entity), v_rows);
    END LOOP;
    CLOSE cur;
  END IF;
END$$

DELIMITER ;

-- ---------------------------------------------------------------------
-- 1. ТОВАРИ: усі таблиці з "product" у назві + відомі таблиці модулів
-- ---------------------------------------------------------------------
CALL lp_orphans('product_id', 'product', 'product_id', '%product%', '');
CALL lp_orphans('product_id', 'product', 'product_id', 'review', '');
CALL lp_orphans('product_id', 'product', 'product_id', 'cart', '');
CALL lp_orphans('product_id', 'product', 'product_id', 'simple\\_cart', '');
CALL lp_orphans('product_id', 'product', 'product_id', 'customer\\_wishlist', '');
CALL lp_orphans('product_id', 'product', 'product_id', 'ebay\\_listing%', '');
CALL lp_orphans('product_id', 'product', 'product_id', 'etsy\\_listing', '');
CALL lp_orphans('product_id', 'product', 'product_id', 'hpmodel%', '');
CALL lp_orphans('product_id', 'product', 'product_id', 'kjseries%', '');
-- Схожі товари: друга сторона зв'язку
CALL lp_orphans('related_id', 'product', 'product_id', 'product\\_related', '');
-- Значення опцій без самої опції товару
CALL lp_orphans('product_option_id', 'product_option', 'product_option_id', 'product\\_option\\_value', '');

-- ---------------------------------------------------------------------
-- 2. КАТЕГОРІЇ (таблиці блогу/статей/галереї мають свої категорії — пропускаємо)
-- ---------------------------------------------------------------------
CALL lp_orphans('category_id', 'category', 'category_id', '%category%', 'blog|article|gallery');
CALL lp_orphans('category_id', 'category', 'category_id', 'ocfilter%', '');

-- ---------------------------------------------------------------------
-- 3. ВИРОБНИКИ
-- ---------------------------------------------------------------------
CALL lp_orphans('manufacturer_id', 'manufacturer', 'manufacturer_id', '%manufacturer%', '');
-- Товари з неіснуючим виробником: не видаляємо, а скидаємо виробника
CALL lp_exec('product', 'manufacturer', 'manufacturer_id → неіснуючий виробник (скинуто в 0)',
  'UPDATE `{p}product` x LEFT JOIN `{p}manufacturer` e ON e.manufacturer_id = x.manufacturer_id SET x.manufacturer_id = 0 WHERE x.manufacturer_id <> 0 AND e.manufacturer_id IS NULL');

-- ---------------------------------------------------------------------
-- 4. АТРИБУТИ, ФІЛЬТРИ, ОПЦІЇ, ЗАВАНТАЖЕННЯ
--    (у таблицях OCFilter свої filter_id/option_id — їх не чіпаємо)
-- ---------------------------------------------------------------------
CALL lp_orphans('attribute_id', 'attribute', 'attribute_id', '%attribute%', 'ocfilter');
CALL lp_orphans('attribute_group_id', 'attribute_group', 'attribute_group_id', '%attribute\\_group%', '');
CALL lp_orphans('filter_id', 'filter', 'filter_id', '%filter%', 'ocfilter');
CALL lp_orphans('filter_group_id', 'filter_group', 'filter_group_id', '%filter%', 'ocfilter');
CALL lp_orphans('option_id', 'option', 'option_id', '%option%', 'ocfilter');
CALL lp_orphans('option_value_id', 'option_value', 'option_value_id', '%option%', 'ocfilter');
CALL lp_orphans('download_id', 'download', 'download_id', '%download%', '');

-- OCFilter: значення без фільтра (усередині самого модуля)
CALL lp_exec('ocfilter_filter_value', 'ocfilter_filter', 'filter_id → неіснуючий фільтр OCFilter',
  'DELETE x FROM `{p}ocfilter_filter_value` x LEFT JOIN `{p}ocfilter_filter` e ON e.filter_id = x.filter_id AND e.source = x.source WHERE e.filter_id IS NULL');
CALL lp_exec('ocfilter_filter_value_to_product', 'ocfilter_filter', 'filter_id → неіснуючий фільтр OCFilter',
  'DELETE x FROM `{p}ocfilter_filter_value_to_product` x LEFT JOIN `{p}ocfilter_filter` e ON e.filter_id = x.filter_id AND e.source = x.source WHERE e.filter_id IS NULL');

-- ---------------------------------------------------------------------
-- 5. МОВИ І МАГАЗИНИ (описи видалених мов, прив'язки до видалених магазинів)
-- ---------------------------------------------------------------------
CALL lp_orphans('language_id', 'language', 'language_id', '%description', '');
CALL lp_orphans('language_id', 'language', 'language_id', 'product\\_attribute', '');
CALL lp_orphans('language_id', 'language', 'language_id', 'seo\\_url', '');
CALL lp_orphans('store_id', 'store', 'store_id', '%\\_to\\_store', '');
CALL lp_orphans('store_id', 'store', 'store_id', 'seo\\_url', '');

-- ---------------------------------------------------------------------
-- 6. ЧПУ (seo_url): записи без сторінки, порожні та дублікати
-- ---------------------------------------------------------------------
CALL lp_exec('seo_url', 'product', 'ЧПУ товарів без товару',
  'DELETE s FROM `{p}seo_url` s LEFT JOIN `{p}product` e ON e.product_id = CAST(SUBSTRING_INDEX(s.`query`, ''='', -1) AS UNSIGNED) WHERE s.`query` LIKE ''product\\_id=%'' AND e.product_id IS NULL');
CALL lp_exec('seo_url', 'category', 'ЧПУ категорій без категорії',
  'DELETE s FROM `{p}seo_url` s LEFT JOIN `{p}category` e ON e.category_id = CAST(SUBSTRING_INDEX(s.`query`, ''='', -1) AS UNSIGNED) WHERE s.`query` LIKE ''category\\_id=%'' AND e.category_id IS NULL');
CALL lp_exec('seo_url', 'manufacturer', 'ЧПУ виробників без виробника',
  'DELETE s FROM `{p}seo_url` s LEFT JOIN `{p}manufacturer` e ON e.manufacturer_id = CAST(SUBSTRING_INDEX(s.`query`, ''='', -1) AS UNSIGNED) WHERE s.`query` LIKE ''manufacturer\\_id=%'' AND e.manufacturer_id IS NULL');
CALL lp_exec('seo_url', 'information', 'ЧПУ статей-інформації без сторінки',
  'DELETE s FROM `{p}seo_url` s LEFT JOIN `{p}information` e ON e.information_id = CAST(SUBSTRING_INDEX(s.`query`, ''='', -1) AS UNSIGNED) WHERE s.`query` LIKE ''information\\_id=%'' AND e.information_id IS NULL');
CALL lp_exec('seo_url', 'article', 'ЧПУ статей блогу без статті',
  'DELETE s FROM `{p}seo_url` s LEFT JOIN `{p}article` e ON e.article_id = CAST(SUBSTRING_INDEX(s.`query`, ''='', -1) AS UNSIGNED) WHERE s.`query` LIKE ''article\\_id=%'' AND e.article_id IS NULL');
CALL lp_exec('seo_url', 'blog_category', 'ЧПУ категорій блогу без категорії',
  'DELETE s FROM `{p}seo_url` s LEFT JOIN `{p}blog_category` e ON e.blog_category_id = CAST(SUBSTRING_INDEX(s.`query`, ''='', -1) AS UNSIGNED) WHERE s.`query` LIKE ''blog\\_category\\_id=%'' AND e.blog_category_id IS NULL');
CALL lp_exec('seo_url', 'gallery', 'ЧПУ галерей без галереї',
  'DELETE s FROM `{p}seo_url` s LEFT JOIN `{p}gallery` e ON e.gallery_id = CAST(SUBSTRING_INDEX(s.`query`, ''='', -1) AS UNSIGNED) WHERE s.`query` LIKE ''gallery\\_id=%'' AND e.gallery_id IS NULL');
CALL lp_exec('seo_url', 'ocfilter_page', 'ЧПУ SEO-сторінок OCFilter без сторінки',
  'DELETE s FROM `{p}seo_url` s LEFT JOIN `{p}ocfilter_page` e ON e.page_id = CAST(SUBSTRING_INDEX(s.`query`, ''='', -1) AS UNSIGNED) WHERE s.`query` LIKE ''ocfilter\\_page\\_id=%'' AND e.page_id IS NULL');
-- Якщо таблиці OCFilter-сторінок немає взагалі — її ЧПУ теж сміття
CALL lp_exec('seo_url', '', 'ЧПУ OCFilter, коли модуля немає',
  'DELETE FROM `{p}seo_url` WHERE `query` LIKE ''ocfilter\\_page\\_id=%'' AND NOT EXISTS (SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ''{p}ocfilter_page'')');
CALL lp_exec('seo_url', '', 'порожні ЧПУ',
  'DELETE FROM `{p}seo_url` WHERE TRIM(`keyword`) = '''' OR TRIM(`query`) = ''''');
CALL lp_exec('seo_url', '', 'дублікати (той самий магазин + мова + сторінка), лишаємо найстаріший',
  'DELETE s FROM `{p}seo_url` s JOIN `{p}seo_url` d ON d.store_id = s.store_id AND d.language_id = s.language_id AND d.`query` = s.`query` AND d.seo_url_id < s.seo_url_id');

-- Старий формат ЧПУ (OpenCart 2 / ocStore 2), якщо таблиця лишилась після оновлення
CALL lp_exec('url_alias', 'product', 'старі ЧПУ товарів без товару',
  'DELETE s FROM `{p}url_alias` s LEFT JOIN `{p}product` e ON e.product_id = CAST(SUBSTRING_INDEX(s.`query`, ''='', -1) AS UNSIGNED) WHERE s.`query` LIKE ''product\\_id=%'' AND e.product_id IS NULL');
CALL lp_exec('url_alias', 'category', 'старі ЧПУ категорій без категорії',
  'DELETE s FROM `{p}url_alias` s LEFT JOIN `{p}category` e ON e.category_id = CAST(SUBSTRING_INDEX(s.`query`, ''='', -1) AS UNSIGNED) WHERE s.`query` LIKE ''category\\_id=%'' AND e.category_id IS NULL');
CALL lp_exec('url_alias', 'manufacturer', 'старі ЧПУ виробників без виробника',
  'DELETE s FROM `{p}url_alias` s LEFT JOIN `{p}manufacturer` e ON e.manufacturer_id = CAST(SUBSTRING_INDEX(s.`query`, ''='', -1) AS UNSIGNED) WHERE s.`query` LIKE ''manufacturer\\_id=%'' AND e.manufacturer_id IS NULL');

-- ---------------------------------------------------------------------
DROP PROCEDURE IF EXISTS lp_exec;
DROP PROCEDURE IF EXISTS lp_orphans;

-- Звіт: що саме було видалено
SELECT tbl AS `таблиця`, what AS `що`, removed AS `видалено рядків`
FROM lp_report
WHERE removed > 0
ORDER BY tbl, what;

SELECT COALESCE(SUM(removed), 0) AS `усього видалено` FROM lp_report;

-- Що лишилось у ЧПУ за типами сторінок (для контролю)
SET @lp_sql = REPLACE('SELECT SUBSTRING_INDEX(`query`, ''='', 1) AS `тип ЧПУ`, COUNT(*) AS `кількість` FROM `{p}seo_url` GROUP BY 1 ORDER BY 2 DESC', '{p}', @p);
PREPARE lp_stmt FROM @lp_sql;
EXECUTE lp_stmt;
DEALLOCATE PREPARE lp_stmt;

DROP TEMPORARY TABLE IF EXISTS lp_report;
