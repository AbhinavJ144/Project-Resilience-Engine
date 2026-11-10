# One-Page Summary of Assumptions, Lineage & Methodology

## 1. Empirical Foundation (DataCo Smart Supply Chain Dataset)
- **Source & Encoding**: `DataCoSupplyChainDataset.csv` (180,519 commercial transactions, `latin-1` encoded, spanning `2015-01-01` to `2018-01-31`).
- **Real Fields Used**: `order date (DateOrders)`, `shipping date (DateOrders)`, `Days for shipping (real)`, `Days for shipment (scheduled)`, `Late_delivery_risk`, `Order Region`, `Market`, `Shipping Mode`, `Product Name`, `Category Name`, `Order Item Quantity`, `Order Item Product Price`, `Sales`, and `Order Profit Per Order`.
- **Engineered Features**:
  - `delay_delta = Days for shipping (real) - Days for shipment (scheduled)`
  - Aggregated into **136 core Product-Region SKU lanes** across the top 10 global regions and top 10 product categories (`169.8 KB` compact JSON in `/app/public/data/supply_chain_data.json`) so all client-side calculations execute in **< 5 ms**.

## 2. Predictive Late-Delivery Risk Model
- **Model Architecture**: Gradient Boosting Classifier (`n_estimators=80, max_depth=4`) benchmarked against Logistic Regression on a stratified 45,000-order sample (36,000 train / 9,000 test).
- **Features**: `Order Region`, `Shipping Mode`, `Days for shipment (scheduled)`, `Category Name` $\rightarrow$ predicting `Late_delivery_risk`.
- **Holdout Performance**:
  - **Gradient Boosting Accuracy**: `69.41%` | **Logistic Regression Accuracy**: `69.43%`
  - **ROC-AUC**: `0.7323` | **Precision**: `84.07%` | **Recall**: `54.49%` | **F1 Score**: `0.6613`
- **Dynamic Coupling**: Baseline lane risk probabilities (`model_risk_prob`) adjust dynamically as the user pulls the Disruption Lever (`+2.8%` late probability per extra transit day) or degrades supplier reliability.

## 3. Seeded Reproducible Synthetic Layer (`seed = 42`)
Because the historical DataCo dataset contains order transactions without live warehouse inventory or supplier contracts, the following synthetic layer is seeded deterministically on top:
1. **Stock on Hand (`initial_stock`)**: Seeded relative to each lane's baseline Reorder Point ($\text{ROP}_0$) so that at baseline (`+0d` lever): ~76% of lanes start **Healthy** ($\text{stock} > \text{ROP}$), ~15% start near **Tier 1 Watch**, ~7% near **Tier 2 Critical**, and ~2% in **Tier 3 Emergency**.
2. **Regional Hubs & Suppliers**: Each of the 10 regions is mapped to a primary fulfillment hub (e.g., *Rotterdam EuroHub DC-01*, *Panama Canal FreeZone DC-02*, *Singapore Tuas MegaHub DC-08*), an alternate backup hub, a primary vendor, and an alternate vendor with baseline reliability between `86%` and `96%`.
3. **Freight & Expedite Rate Card**:
   - `Standard Class`: \$4.20 base + \$1.10 handling/unit
   - `Second Class`: \$6.80 base + \$1.80 expedite + \$1.35 handling/unit
   - `First Class`: \$11.50 base + \$4.50 expedite + \$1.90 handling/unit
   - `Air Expedite (Same Day Charter)`: \$19.80 base + \$9.20 expedite premium + \$2.60 handling/unit
4. **SLA Penalty & Governance Thresholds**: Regional SLA penalty rates range from `7.0%` to `9.5%` of expected late order value. Expedited Purchase Orders exceeding **\$25,000** require **VP / Head of Supply Chain (HOD)** approval.
5. **Staff Directory**: 30 fictional regional stakeholders (Supervisor, Operations Manager, and VP/HOD per region) with email addresses and Slack/WhatsApp handles.

## 4. Exact Client-Side Mathematical Formulas
- **Safety Stock**: $\text{SS} = z \cdot \sigma_d \cdot \sqrt{L}$ (default $z = 1.65$, adjustable $1.00$ to $2.60$)
- **Reorder Point**: $\text{ROP} = d \cdot L + \text{SS}$
- **Days of Cover**: $\text{Days of Cover} = \text{stock} / d$
- **Severity ($s$)**: $s = \text{clamp}(1 - \text{stock}/\text{ROP}, 0, 1)$
- **Revenue at Risk**: $\max(0, d \cdot L - \text{stock}) \times \text{unit\_price}$
- **SLA Penalty**: $\text{sla\_penalty\_rate} \times \text{value\_of\_orders\_expected\_late}$
- **Landed Cost Delta**: $(\text{freight} + \text{expedite\_premium} + \text{handling}) - \text{baseline\_shipping\_cost}$
- **Total Cost of Disruption (TCD)**: $\text{lost\_margin} + \text{sla\_penalties} + \text{mitigation\_cost} + \text{extra\_holding\_cost}$
