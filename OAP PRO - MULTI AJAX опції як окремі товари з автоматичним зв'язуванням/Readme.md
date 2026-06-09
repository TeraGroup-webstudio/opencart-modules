# OAP PRO — MULTI AJAX опції як окремі товари з автоматичним зв'язуванням

🛒 [Придбати на OpenCart Forum](https://opencartforum.com/files/file/9221-oap-pro-multi-ajax-opciyi-yak-okremi-tovari-z-avtomatichnim-zvyazuvannyam/)

## Встановлення

Завантажити `Default.ocmod.zip` через **Адмінка → Установка доповнень**.

## Відома проблема: відсутня функція `isMainOapProduct`

Якщо виникає помилка:

```
Notice: Undefined property: Proxy::isMainOapProduct in
.../modification/system/engine/action.php on line 79
```

У файл `catalog/model/catalog/product.php` треба додати функцію:

```php
public function isMainOapProduct($product_id) {
    $group_query = $this->db->query("SELECT gpgp.product_group_id FROM " . DB_PREFIX . "sppro_group_product_group_products gpgp WHERE gpgp.product_id = '" . (int)$product_id . "' LIMIT 1");

    if (!$group_query->num_rows) {
        return true;
    }

    $product_group_id = $group_query->row['product_group_id'];

    $main_query = $this->db->query("SELECT main_product_id FROM " . DB_PREFIX . "sppro_group_product_group WHERE product_group_id = '" . (int)$product_group_id . "' LIMIT 1");

    if ($main_query->num_rows && $main_query->row['main_product_id']) {
        return (int)$main_query->row['main_product_id'] === (int)$product_id;
    }

    $first_query = $this->db->query("SELECT product_id FROM " . DB_PREFIX . "sppro_group_product_group_products WHERE product_group_id = '" . (int)$product_group_id . "' ORDER BY product_id ASC LIMIT 1");

    if ($first_query->num_rows) {
        return (int)$first_query->row['product_id'] === (int)$product_id;
    }

    return true;
}
```

## Додатково

Змінити в модульній модифікації `Default.ocmod` текст: замість `text_home` написати `text_yes`.
