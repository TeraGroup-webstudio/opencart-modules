# Пошук — Search з автодоповненням та морфологією PRO

## Включає два модулі

- **Search suggestion** — пошук з автодоповненням PRO
- **Пошукова система з морфологією та релевантністю PRO**

## Встановлення

1. Закидуємо весь вміст папки `upload` у корінь сайту.

2. У файлі `catalog/controller/extension/module/search_suggestion.php` шукаємо:

```php
'more' => $remainder_cnt . $this->language->get('more_results'),
```

і замінюємо на:

```php
'more' => $this->language->get('more_results') . $remainder_cnt,
```
