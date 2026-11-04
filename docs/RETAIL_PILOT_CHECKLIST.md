# Shop (retail) pilot checklist

For the first real store (grocery, supermarket, mini-market, bakery counter). Goal: run the shop for
3 to 5 days on WENZDES POS and find what breaks while the owner can still fall back on his old way.
Written 2026-11-04 for version 0.8.0 (shop stock, import, barcodes). Everything marked **tested** was
run in the real app by the acceptance suite; everything marked **not tested** has never touched real
hardware and is exactly what the pilot is for.

## 0. Know what is and is not in the product

| Area | State |
|---|---|
| Barcode scanning at the till (USB scanner that types like a keyboard), main + carton barcodes | tested with simulated scans, **not tested with a real scanner** |
| Deli / produce scale labels (prefix + item code + weight or price) | tested with computed labels, **not tested with a real scale** |
| Per-product stock: sale lowers it, receiving raises it, count, adjust, movement log, low alerts | tested |
| Refuse a sale the stock cannot cover (off by default) | tested |
| Import a product list from Excel (paste or CSV) with categories, costs, opening stock | tested |
| Weighed products, margin profit, debts book, refunds with return-to-shelf | tested |
| Printing barcode labels for products that have none | **not built**: the till generates the number, the owner prints stickers elsewhere |
| Product sizes / colours, expiry dates, batches, a different tax per product | **not built** |
| Wireless or Bluetooth scanners that need a driver, scanners that add a prefix/suffix | **not tested** |
| Barcode of a weighed item scanned with the scale price in a currency with decimals | **not tested** |

## 1. Before visiting the shop (at our desk)

- [ ] Ask the owner for his product list in Excel (name, barcode, selling price, cost, category, quantity). Any shape: we map the columns.
- [ ] Ask which scanner, receipt printer, cash drawer and PC he has. Ask if he has a deli/produce scale with a label printer, and the model.
- [ ] If there is a scale: get its label format from the supplier (prefix, number of item-code digits, weight in grams or amount).
- [ ] Install the **current** installer on a spare PC and import his list there first. Fix the file, not the shop.
- [ ] Decide the plan: POS (Full) is needed for stock, import and reports. POS Lite sells and scans but has no stock screens.

## 2. At the shop, day 0 (about 3 hours)

1. **Install** the current installer on the till PC, activate the licence, set the shop name, currency, tax, printer.
2. **Mode:** Settings, choose "بقالة / متجر" (no tables, no kitchen).
3. **Import products:** Stock screen, "استيراد من ملف", paste the list. Read the preview: every bad row has a reason. Fix the Excel and paste again; importing twice only updates.
4. **Opening quantities:** do a real count of the shelf and put it in the "الكمية" column. If the owner will not count yet: import without it and turn on tracking per product later.
5. **Costs:** every product needs a cost or the margin profit is wrong. The dashboard warns about products sold with no cost.
6. **Barcodes:**
   - [ ] Scan 20 real products at the till. Each must add the right product. A wrong or missing one: fix its barcode in the Products screen.
   - [ ] Products with no barcode: "توليد باركود" in the product dialog, print stickers, stick them on.
   - [ ] Cartons: add the carton barcode and its piece count in the product dialog; scan one and check the quantity.
   - [ ] Scale: enter the prefix and digit counts in "الباركود والإعدادات". Print a label from the scale and scan it: right product, right grams, right price. Check 3 different products.
7. **Cash drawer and receipt:** one cash sale, one card sale, one refund with "return to shelf". Check the drawer opens and the receipt prints with the shop name.
8. **Staff:** create the cashiers with PINs. Open and close a shift once with the real cash.
9. **Backup:** Settings, backup, choose a second drive or USB folder.
10. **Train the cashier for 15 minutes:** scan, weigh, pay, refund, what the "out of stock" warning means, what to do when a barcode is not found (search by name).

## 3. Each pilot day (10 minutes at closing)

- [ ] Compare the day's sales total with his old method / the cash in the drawer.
- [ ] Stock screen, low-stock tab: does it match what he sees on the shelf?
- [ ] Count 5 random products on the shelf against the screen. Note every difference and why (unscanned sale, goods received but not entered, theft, wrong barcode).
- [ ] Anything the cashier had to do twice, or could not do. Write it down in the cashier's words.
- [ ] Back up.

## 4. What to measure

- Seconds from scanning to the item in the cart (should be instant).
- Scans that did not find a product (wrong or missing barcode) per day.
- Sales that needed a manager.
- Stock difference on the 5-product counts at the end of day 3 (our target: no more than a piece or two).
- Anything the owner asked for that is not in the list in section 0.

## 5. Known limits to tell the owner honestly

- Stock may go below zero (goods are sold before the delivery is entered). He can switch on "refuse sale when out of stock" once his stock is accurate.
- A refund does not return goods to the shelf by itself: the cashier ticks "return to stock" for good goods only.
- No supplier invoices or payment ledger for received goods yet: receiving only updates stock and cost. Supplier payments stay in the suppliers screen.
- Stock is per branch; there is no transfer between branches yet.
- Printing price/barcode labels is not built.

## 6. Go / no-go after the pilot

Go when, for three days in a row: the day's total matches, the 5-product count is within a piece or two,
and the cashier works without us. Write the new requests into the plan with the owner's words.
