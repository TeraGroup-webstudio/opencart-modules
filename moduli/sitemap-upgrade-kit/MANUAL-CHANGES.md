# Встановлення sitemap у старий проєкт

## 1. Завантажити upload

Зберегти резервні копії двох PHP-файлів, `robots.txt` і `.htaccess`.

Завантажити та розпакувати архів **upload.zip**. Вміст папки **upload** скопіювати в корінь сайту, де лежить `index.php`. Папка `catalog` має об'єднатися з наявною. Саму папку `upload` не завантажувати.

Готові файли:

```text
catalog/controller/extension/feed/sitemap_multi.php
catalog/model/extension/feed/sitemap_multi.php
catalog/view/theme/default/stylesheet/sitemap_multi_html.css
catalog/view/theme/default/stylesheet/sitemap_multi_xml.css
```

Цей комплект призначений для старих проєктів із сумісною версією модуля `sitemap_multi`, як у tgcart. Якщо контролер або модель містять власні доробки, порівняти їх перед заміною. Інші PHP-файли для такого встановлення правити не потрібно. Модуль має бути ввімкнений; PHP — мати DOM/libxml.

## 2. Правка robots.txt

Додати в кінець файлу, **замінивши `YOUR-DOMAIN` своїм доменом**:

```text
Sitemap: https://YOUR-DOMAIN/index.php?route=extension/feed/sitemap_multi&view=xml
```

Якщо рядок для цього sitemap уже є, замінити його, не дублювати. Інші Sitemap та чинні Allow/Disallow залишити. У robots.txt використовувати звичайний `&`, а не `&amp;`.

## 3. Правки .htaccess — Apache

### 3.1. Адреса /sitemap.xml

Знайти старе правило:

```apache
RewriteRule ^sitemap.xml$ index.php?route=extension/feed/sitemap_multi [L]
```

Замінити на:

```apache
RewriteRule ^sitemap\.xml$ index.php?route=extension/feed/sitemap_multi&view=xml [L]
```

Якщо старого правила немає, вставити нове після `RewriteEngine On` / `RewriteBase`, **перед загальним SEO-правилом** із `RewriteCond %{REQUEST_FILENAME} !-f`.

### 3.2. Виключення з редиректу page=1

Лише якщо у файлі є такий блок:

```apache
RewriteCond %{QUERY_STRING} ^(.*)&?page=1$
RewriteRule ^(.*)/?$ /$1?%1%2 [R=301,L]
```

Додати один RewriteCond **безпосередньо перед його першою умовою**. Результат:

```apache
RewriteCond %{QUERY_STRING} !(^|&)route=extension(/|%2f)feed(/|%2f)sitemap_multi(&|$) [NC]
RewriteCond %{QUERY_STRING} ^(.*)&?page=1$
RewriteRule ^(.*)/?$ /$1?%1%2 [R=301,L]
```

Власне правило редиректу залишити таким, як воно було в проєкті. Якщо блоку немає, не додавати його: виключення не потрібне. Не вставляти окремий RewriteCond перед правилом sitemap.xml.

### Особливість Ukraine.com.ua

Для звичайного хостингу Ukraine.com.ua використовувати наведені правила .htaccess. Nginx може віддавати статичні файли, оминаючи Apache. Писати власну конфігурацію Nginx для цього пакета не потрібно.

Якщо /sitemap.xml показує старий XML або правило не спрацьовує:

1. У панелі adm.tools відкрити налаштування потрібного сайту → «Статичні файли».
2. Якщо у списку є розширення xml, прибрати лише його та зберегти. CSS, JS і зображення залишити статичними.
3. Зачекати приблизно 10–15 хвилин і перевірити /sitemap.xml знову.

Це потрібно для передачі XML-запитів до Apache. Якщо xml уже відсутній, список не змінювати. Не видаляти старий sitemap.xml навмання: спочатку зберегти резервну копію та перевірити, що нове правило працює.

Пряма адреса index.php?route=extension/feed/sitemap_multi&view=xml не має розширення .xml, тому для її використання в robots.txt змінювати список статичних файлів не потрібно. Вона залишається основною адресою пакета.

Якщо сайт переведено з Apache на PHP-FPM або інший обробник, уточнити підтримку .htaccess у підтримки хостингу; наведене правило розраховане на Apache.

Джерело: [документація Ukraine.com.ua про статичні файли](https://www.ukraine.com.ua/wiki/hosting/sites/my-sites/site-settings/static-files/).

## 4. Перевірити після завантаження

Підставити домен і відкрити:

```text
https://YOUR-DOMAIN/index.php?route=extension/feed/sitemap_multi&view=html
https://YOUR-DOMAIN/index.php?route=extension/feed/sitemap_multi&view=xml
https://YOUR-DOMAIN/sitemap.xml
```

- HTML має показувати клікабельні частини та посилання на сторінки.
- XML має показувати індекс; кожна дочірня карта повинна відкриватися без помилок.
- `/sitemap.xml` має віддавати новий XML-індекс, а не старий файл.
- У robots.txt має бути правильний домен; у Search Console подати адресу з `view=xml`.

За наявності OCMOD/vQmod, CDN або кешів оновити їх і перевірити, що вони не повертають стару версію. HTML має `noindex,follow`; цей заголовок не повинен переноситися кешем на XML.

Товари динамічної карти автоматично діляться приблизно по 500 URL з урахуванням мов. HTML показує по 200 посилань. Поділ нетоварного розділу `main` та старої статичної генерації не реалізований: для великих обсягів цих розділів потрібне окреме доопрацювання.


HTML-перегляд групує записи за мовами та дозволяє фільтрувати їх. Лічильники стосуються лише відкритої частини карти. Мова визначається зі збігу loc і hreflang; спільні адреси позначаються кількома мовами, невизначені — окремою групою. XML не змінюється.
