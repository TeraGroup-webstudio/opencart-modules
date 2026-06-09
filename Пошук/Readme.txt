Закидуємо весь вміст папки upload.

У файлі catalog/controller/extension/module/search_suggestion.php шукаємо:
'more' => $remainder_cnt . $this->language->get('more_results'),

і замінюємо на:
'more' => $this->language->get('more_results') . $remainder_cnt,