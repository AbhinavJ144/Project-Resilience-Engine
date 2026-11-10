import os
import json
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import OneHotEncoder
from sklearn.compose import ColumnTransformer
from sklearn.pipeline import Pipeline
from sklearn.metrics import accuracy_score, roc_auc_score, precision_score, recall_score, f1_score

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(BASE_DIR, "data", "DataCoSupplyChainDataset.csv")
OUT_DIR = os.path.join(BASE_DIR, "app", "public", "data")
os.makedirs(OUT_DIR, exist_ok=True)

def main():
    print("1. Loading DataCo Smart Supply Chain dataset (latin-1)...")
    cols = [
        'order date (DateOrders)', 'shipping date (DateOrders)',
        'Days for shipping (real)', 'Days for shipment (scheduled)',
        'Late_delivery_risk', 'Order Region', 'Market', 'Shipping Mode',
        'Product Name', 'Category Name', 'Order Item Quantity',
        'Order Item Product Price', 'Sales', 'Order Profit Per Order',
        'Order Status', 'Order Id', 'Customer City', 'Customer Country'
    ]
    df = pd.read_csv(CSV_PATH, encoding='latin1', usecols=cols)
    total_raw_rows = len(df)
    print(f"   Loaded {total_raw_rows:,} transaction rows.")

    # Step 1: Data Cleaning & Feature Engineering
    df = df.dropna(subset=[
        'Days for shipping (real)', 'Days for shipment (scheduled)',
        'Order Region', 'Category Name', 'Product Name', 'Shipping Mode'
    ])
    df['delay_delta'] = df['Days for shipping (real)'] - df['Days for shipment (scheduled)']
    df['order_date'] = pd.to_datetime(df['order date (DateOrders)'], errors='coerce')
    
    # Calculate active date span in dataset to normalize daily demand nicely
    min_date = df['order_date'].min()
    max_date = df['order_date'].max()
    total_days_span = max(1, (max_date - min_date).days)
    print(f"   Date span: {min_date.strftime('%Y-%m-%d')} to {max_date.strftime('%Y-%m-%d')} ({total_days_span} days)")

    # Step 2: Train Risk Model (predicting Late_delivery_risk from region, shipping mode, scheduled days, and category)
    print("2. Training Late Delivery Risk Model (Gradient Boosting & Logistic Regression)...")
    # Sample 45,000 rows stratified for fast, reproducible training
    df_model = df.sample(n=min(45000, len(df)), random_state=42)
    feature_cols = ['Order Region', 'Shipping Mode', 'Days for shipment (scheduled)', 'Category Name']
    X = df_model[feature_cols]
    y = df_model['Late_delivery_risk'].astype(int)

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

    preprocessor = ColumnTransformer(
        transformers=[
            ('cat', OneHotEncoder(handle_unknown='ignore', sparse_output=False), ['Order Region', 'Shipping Mode', 'Category Name']),
            ('num', 'passthrough', ['Days for shipment (scheduled)'])
        ]
    )

    gb_clf = Pipeline(steps=[
        ('prep', preprocessor),
        ('clf', GradientBoostingClassifier(n_estimators=80, max_depth=4, learning_rate=0.1, random_state=42))
    ])
    gb_clf.fit(X_train, y_train)
    y_pred = gb_clf.predict(X_test)
    y_prob = gb_clf.predict_proba(X_test)[:, 1]

    lr_clf = Pipeline(steps=[
        ('prep', preprocessor),
        ('clf', LogisticRegression(max_iter=500, random_state=42))
    ])
    lr_clf.fit(X_train, y_train)
    lr_acc = accuracy_score(y_test, lr_clf.predict(X_test))

    model_metrics = {
        "model_type": "Gradient Boosting Classifier (with Logistic Regression benchmark)",
        "gb_accuracy": round(float(accuracy_score(y_test, y_pred)), 4),
        "lr_accuracy": round(float(lr_acc), 4),
        "roc_auc": round(float(roc_auc_score(y_test, y_prob)), 4),
        "precision": round(float(precision_score(y_test, y_pred)), 4),
        "recall": round(float(recall_score(y_test, y_pred)), 4),
        "f1_score": round(float(f1_score(y_test, y_pred)), 4),
        "features_used": ["Order Region", "Shipping Mode", "Days for shipment (scheduled)", "Category Name"],
        "target": "Late_delivery_risk",
        "training_rows": int(len(X_train)),
        "test_rows": int(len(X_test)),
        "total_dataset_rows": int(total_raw_rows),
        "date_range": f"{min_date.strftime('%Y-%m-%d')} to {max_date.strftime('%Y-%m-%d')}"
    }
    print(f"   Model Accuracy: GB={model_metrics['gb_accuracy']*100:.2f}%, LR={model_metrics['lr_accuracy']*100:.2f}%, AUC={model_metrics['roc_auc']:.4f}")

    # Predict probabilities across unique combinations of (Order Region, Shipping Mode, Days for shipment (scheduled), Category Name)
    unique_combos = df[feature_cols].drop_duplicates().copy()
    unique_combos['pred_late_prob'] = gb_clf.predict_proba(unique_combos)[:, 1]
    df = df.merge(unique_combos, on=feature_cols, how='left')

    # Step 3: Select Top 10 Regions and Top 12 Categories (by order volume) so the UI heatmap & SKU table are dense, fast, and representative
    top_regions = df['Order Region'].value_counts().head(10).index.tolist()
    top_categories = df['Category Name'].value_counts().head(10).index.tolist()
    df_top = df[df['Order Region'].isin(top_regions) & df['Category Name'].isin(top_categories)].copy()

    # Calculate daily demand statistics per (Order Region, Product Name, Category Name)
    print("3. Aggregating to Product-Region SKU lanes and engineering synthetic inventory layer...")
    df_top['order_day'] = df_top['order_date'].dt.floor('D')

    # Group by Region, Category, Product
    mode_map = df_top.groupby(['Order Region', 'Category Name', 'Product Name'])['Shipping Mode'].agg(lambda x: x.value_counts().index[0]).to_dict()
    grp = df_top.groupby(['Order Region', 'Category Name', 'Product Name', 'Market'], as_index=False).agg(
        total_orders=('Order Id', 'count'),
        total_qty=('Order Item Quantity', 'sum'),
        unit_price=('Order Item Product Price', 'mean'),
        total_sales=('Sales', 'sum'),
        total_profit=('Order Profit Per Order', 'sum'),
        avg_profit_per_order=('Order Profit Per Order', 'mean'),
        real_ship_days=('Days for shipping (real)', 'mean'),
        sched_ship_days=('Days for shipment (scheduled)', 'mean'),
        delay_delta_mean=('delay_delta', 'mean'),
        delay_delta_std=('delay_delta', 'std'),
        empirical_late_rate=('Late_delivery_risk', 'mean'),
        model_risk_prob=('pred_late_prob', 'mean')
    )
    grp['dominant_ship_mode'] = grp.set_index(['Order Region', 'Category Name', 'Product Name']).index.map(mode_map)

    # Filter to active lanes with meaningful order count (top 140 product-region lanes across all 10 regions x 10 categories)
    grp = grp.sort_values('total_sales', ascending=False).groupby(['Order Region', 'Category Name']).head(2).reset_index(drop=True)
    print(f"   Selected {len(grp)} core Product-Region SKU lanes across {grp['Order Region'].nunique()} regions and {grp['Category Name'].nunique()} categories.")

    # Seeded reproducible synthetic layer
    rng = np.random.default_rng(42)

    # Synthetic Reference Tables
    freight_rates = {
        "Standard Class": {"base_per_unit": 4.20, "expedite_premium": 0.0, "handling_per_unit": 1.10, "lead_time_days": 5.5, "days_saved": 0.0},
        "Second Class":   {"base_per_unit": 6.80, "expedite_premium": 1.80, "handling_per_unit": 1.35, "lead_time_days": 4.0, "days_saved": 1.5},
        "First Class":    {"base_per_unit": 11.50, "expedite_premium": 4.50, "handling_per_unit": 1.90, "lead_time_days": 2.2, "days_saved": 3.3},
        "Same Day":       {"base_per_unit": 19.80, "expedite_premium": 9.20, "handling_per_unit": 2.60, "lead_time_days": 1.0, "days_saved": 4.5}
    }

    regional_infra = {
        "Western Europe":   {"hub": "Rotterdam EuroHub DC-01", "alt_hub": "Antwerp Backup DC-04", "primary_supplier": "RheinMetallica Logistics GmbH", "alt_supplier": "Iberia FastTrack S.A.", "supplier_reliability": 0.94, "sla_penalty_rate": 0.08},
        "Central America":  {"hub": "Panama Canal FreeZone DC-02", "alt_hub": "San José Regional Hub", "primary_supplier": "Isthmus Global Supply Co.", "alt_supplier": "Veracruz Express Cargo", "supplier_reliability": 0.88, "sla_penalty_rate": 0.07},
        "South America":    {"hub": "Santos Port Distribution DC-03", "alt_hub": "Callao Pacific Hub", "primary_supplier": "Mercosur Freight & Supply", "alt_supplier": "Andean Rapid Logistics", "supplier_reliability": 0.86, "sla_penalty_rate": 0.075},
        "Northern Europe":  {"hub": "Gothenburg Nordic DC-05", "alt_hub": "Hamburg Gateway DC", "primary_supplier": "NordicStar Supply AB", "alt_supplier": "Baltic Maritime Partners", "supplier_reliability": 0.96, "sla_penalty_rate": 0.085},
        "Southern Europe":  {"hub": "Valencia MedPort DC-06", "alt_hub": "Genoa Tirreno Hub", "primary_supplier": "MedLine Supply Partners", "alt_supplier": "Adriatic Express S.r.l.", "supplier_reliability": 0.91, "sla_penalty_rate": 0.08},
        "Oceania":          {"hub": "Sydney Botany Port DC-07", "alt_hub": "Melbourne South Hub", "primary_supplier": "SouthernCross Logistics Pty", "alt_supplier": "Tasman AirFreight Ltd", "supplier_reliability": 0.92, "sla_penalty_rate": 0.09},
        "Southeast Asia":   {"hub": "Singapore Tuas MegaHub DC-08", "alt_hub": "Port Klang Regional DC", "primary_supplier": "Straits Apex Manufacturing", "alt_supplier": "Mekong Delta Rapid Supply", "supplier_reliability": 0.90, "sla_penalty_rate": 0.075},
        "Caribbean":        {"hub": "Kingston Transshipment DC-09", "alt_hub": "San Juan Atlantic Hub", "primary_supplier": "Antilles Trade & Supply", "alt_supplier": "Miami Gateway AirCargo", "supplier_reliability": 0.87, "sla_penalty_rate": 0.07},
        "West of USA ":     {"hub": "Long Beach Pacific DC-10", "alt_hub": "Oakland Bay Area Hub", "primary_supplier": "PacificCoast Fulfillment Inc.", "alt_supplier": "Sierra Nevada Express", "supplier_reliability": 0.93, "sla_penalty_rate": 0.095},
        "East of USA":      {"hub": "Savannah Atlantic Port DC-11", "alt_hub": "Newark Liberty Hub", "primary_supplier": "AtlanticSeaboard Supply Corp.", "alt_supplier": "Appalachian Rapid Freight", "supplier_reliability": 0.94, "sla_penalty_rate": 0.095}
    }

    staff_directory = {}
    first_names = ["Elena", "Marcus", "Sofia", "henrik", "Carlos", "Liam", " Mei", "Devon", "claire", "Rajesh",
                   "Lucas", "Nadia", "Mateo", "Freja", "Lorenzo", "Chloe", "Wei", "Andre", "Rachel", "Vikram",
                   "Julian", "Camila", "Thiago", "Astrid", "Marco", "Hannah", "Jin", "Xavier", "scully", "Arjun"]
    last_names = ["Vandenberg", "Rojas", "Silva", "Lindqvist", "Moretti", "O'Connor", "Tanaka", "Baptiste", "Kowalski", "Patel",
                  "Meyer", "Castillo", "Costa", "Bergstrom", "Conti", "Evans", "Chen", "Dupont", "stevens", "Mehta"]

    for idx, reg in enumerate(top_regions):
        clean_reg = reg.strip()
        slug = clean_reg.lower().replace(" ", ".")
        staff_directory[reg] = {
            "region": clean_reg,
            "supervisor": {
                "role": "Regional Logistics Supervisor",
                "name": f"{first_names[idx % len(first_names)].strip().title()} {last_names[idx % len(last_names)].strip().title()}",
                "email": f"supervisor.{slug}@dataco-resilience.io",
                "slack_handle": f"@{slug}_sup"
            },
            "manager": {
                "role": "Supply Chain Operations Manager",
                "name": f"{first_names[(idx+10) % len(first_names)].strip().title()} {last_names[(idx+5) % len(last_names)].strip().title()}",
                "email": f"manager.{slug}@dataco-resilience.io",
                "slack_handle": f"@{slug}_mgr"
            },
            "hod": {
                "role": "VP & Head of Global Supply Chain (HOD)",
                "name": f"{first_names[(idx+20) % len(first_names)].strip().title()} {last_names[(idx+11) % len(last_names)].strip().title()}",
                "email": f"hod.{slug}@dataco-resilience.io",
                "slack_handle": f"@hod_{slug}"
            }
        }

    lanes = []
    for i, row in grp.iterrows():
        reg = row['Order Region']
        cat = row['Category Name']
        prod = row['Product Name']
        infra = regional_infra.get(reg, {
            "hub": f"{reg.strip()} Central DC",
            "alt_hub": f"{reg.strip()} Backup Hub",
            "primary_supplier": f"{reg.strip()} Primary Supplier",
            "alt_supplier": f"{reg.strip()} Alternate Vendor",
            "supplier_reliability": 0.90,
            "sla_penalty_rate": 0.08
        })

        # Scale daily demand d so that across a 90-day active window it reflects realistic continuous velocity
        raw_daily = max(4.5, round((row['total_qty'] / max(120, total_days_span * 0.12)) * rng.uniform(1.8, 3.2), 2))
        sigma_d = round(raw_daily * rng.uniform(0.32, 0.48), 2)
        base_lead_time = round(float(row['real_ship_days']) + rng.uniform(0.8, 2.2), 2)
        sched_lead_time = round(float(row['sched_ship_days']) + 1.0, 2)

        # Baseline SS and ROP at z = 1.65
        z_default = 1.65
        base_ss = z_default * sigma_d * np.sqrt(base_lead_time)
        base_rop = raw_daily * base_lead_time + base_ss

        # Seed baseline stock so that:
        # ~76% of lanes start HEALTHY (above ROP at 0d lever)
        # ~15% start in Tier 1 WATCH (between SS and ROP, and cross into Tier 2 & Tier 3 as lever pulls +4d to +10d)
        # ~9% start near SS so that pulling lever to +4d triggers Tier 2 CRITICAL and +8d..+10d triggers Tier 3 EMERGENCY!
        roll = rng.random()
        if roll < 0.72:
            stock_ratio = rng.uniform(1.06, 1.42)
            initial_stock = round(base_rop * stock_ratio, 0)
        elif roll < 0.88:
            # Starts in Tier 1 Watch (above SS_0, below ROP_0), crosses SS(L) at +4d..+8d
            initial_stock = round(base_ss * rng.uniform(1.12, 1.38), 0)
        else:
            # Starts near top of SS_0 (Tier 1 Watch at 0d), crosses SS(L) at +2d (Tier 2) and crosses 0.5*SS(L) or cover threshold at +7d..+10d (Tier 3)
            initial_stock = round(base_ss * rng.uniform(1.02, 1.14), 0)
        unit_price = round(float(row['unit_price']), 2)
        # Ensure positive baseline margin ratio (DataCo has some negative profit rows due to promotional discounts; bound margin between 18% and 42% for clear MBA unit economics while preserving actual average profit per order in metadata)
        raw_margin_ratio = float(row['total_profit']) / max(1.0, float(row['total_sales']))
        margin_ratio = round(float(np.clip(raw_margin_ratio if raw_margin_ratio > 0.12 else rng.uniform(0.22, 0.36), 0.18, 0.45)), 3)

        lane_id = f"LANE-{i+1:03d}"
        lanes.append({
            "id": lane_id,
            "region": reg.strip(),
            "raw_region": reg,
            "market": row['Market'],
            "category": cat,
            "product": prod,
            "total_historical_orders": int(row['total_orders']),
            "total_historical_qty": int(row['total_qty']),
            "unit_price": unit_price,
            "margin_ratio": margin_ratio,
            "historical_avg_profit_per_order": round(float(row['avg_profit_per_order']), 2),
            "daily_demand": raw_daily,
            "sigma_d": sigma_d,
            "base_lead_time": base_lead_time,
            "scheduled_lead_time": sched_lead_time,
            "delay_delta_mean": round(float(row['delay_delta_mean']), 2),
            "delay_delta_std": round(float(0.0 if np.isnan(row['delay_delta_std']) else row['delay_delta_std']), 2),
            "empirical_late_rate": round(float(row['empirical_late_rate']), 4),
            "model_risk_prob": round(float(row['model_risk_prob']), 4),
            "dominant_ship_mode": row['dominant_ship_mode'],
            "initial_stock": int(initial_stock),
            "warehouse_hub": infra["hub"],
            "alternate_hub": infra["alt_hub"],
            "primary_supplier": infra["primary_supplier"],
            "alternate_supplier": infra["alt_supplier"],
            "supplier_reliability": infra["supplier_reliability"],
            "sla_penalty_rate": infra["sla_penalty_rate"],
            "holding_cost_per_unit_day": round(unit_price * 0.0015, 3),
            "fastest_mitigation_lead_time": 1.5
        })

    # Sample affected open customer orders per region for Tier 3 SLA customer warning notices
    sample_orders = []
    df_recent = df_top.sort_values('order_date', ascending=False).head(500)
    for idx, r in df_recent.drop_duplicates(subset=['Order Region', 'Category Name']).head(35).iterrows():
        sample_orders.append({
            "order_id": f"ORD-{int(r['Order Id'])}",
            "region": r['Order Region'].strip(),
            "category": r['Category Name'],
            "product": r['Product Name'],
            "customer_city": str(r['Customer City']),
            "customer_country": str(r['Customer Country']),
            "order_value": round(float(r['Sales']), 2),
            "scheduled_days": int(r['Days for shipment (scheduled)']),
            "real_days": int(r['Days for shipping (real)']),
            "shipping_mode": str(r['Shipping Mode'])
        })

    payload = {
        "metadata": {
            "project": "Project Resilience Engine — Autonomous Supply Chain Control Tower",
            "source_dataset": "DataCo Smart Supply Chain Dataset (180,519 rows, latin-1 encoded)",
            "seed": 42,
            "hod_po_approval_limit": 25000,
            "default_z_score": 1.65,
            "default_cooldown_seconds": 45
        },
        "model_metrics": model_metrics,
        "freight_rates": freight_rates,
        "regional_infrastructure": {k.strip(): v for k, v in regional_infra.items()},
        "staff_directory": {k.strip(): v for k, v in staff_directory.items()},
        "lanes": lanes,
        "sample_affected_orders": sample_orders
    }

    out_file = os.path.join(OUT_DIR, "supply_chain_data.json")
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    file_size_kb = os.path.getsize(out_file) / 1024
    print(f"4. Exported compact JSON to {out_file} ({file_size_kb:.1f} KB)")

if __name__ == "__main__":
    main()
