# Site stocks

Deploy the backend and updated app together. Admin and super-admin users open **Stocks** from the management menu. Existing app deliveries populate stocks automatically through the backend delivery listener; no import action is required. Synchronization preserves usage and valuation. New warehouse dispatches, acceptance and inspections update stocks automatically. Stock documents are created when the first eligible delivery is processed; no manual Firestore schema setup is required.

`stocks` holds one balance per delivery/product line. Different sites, products and units are never added together. Warehouse dispatch quantity is compared with the inspector's actual received quantity. Excess and shortage remain visible; an excess is recorded rather than silently capped. Failed inspections are quarantined and cannot be consumed. Acceptance alone does not release usable stock. Completed legacy weighed deliveries use the site net quantity.

Admins enter a unit cost and explicit currency per receipt, and record usage with a reason/reference. Remaining quantity is usable received quantity minus recorded usage. Remaining value is remaining quantity times that receipt's unit cost. Unpriced receipts have a null value, not a zero price. Currency totals are kept separate. This is receipt-level valuation, not a currency conversion or FIFO costing engine. Quantities only decrease when usage is recorded.

`stockMovements` records immutable admin usage and valuation actions with actor, time and reason. Mutation request IDs prevent double posting on retry. Firestore transactions prevent usage above available quantity and receipt corrections below recorded usage. Warehouse dispatch lines and stocked source deliveries are protected against modification/deletion that would break the receipt trail.

The management Reports screen exports stock CSV. Master Excel includes **Stocks - Current Balances** and **Stock Movements - All Time**, irrespective of the delivery report's date filter. These represent current site inventory, not historical opening/closing balances. Warehouse comparisons use quantities dispatched on warehouse jobs; warehouse opening inventory and warehouse replenishments are not inferred from site receipts.

Verify after deployment: confirm existing deliveries appear automatically, submit a warehouse dispatch, accept it at site, inspect a short/excess receipt, then enter its cost and usage. Confirm balances in Stocks and downloaded reports. Automated tests use an isolated transaction fixture and do not connect to production Firestore.
