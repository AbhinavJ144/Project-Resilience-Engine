/**
 * Core Supply Chain Analytics & Multi-Agent Engine
 * Runs 100% client-side in <5ms so interactive levers update KPIs, heatmaps, and alerts instantaneously.
 */

export function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Linear color interpolation between Concrete (#ece6df) at s=0 and Burgundy (#7f0508) at s=1
 * Healthy items (stock > ROP, s === 0) use Aquamarine/Concrete tint.
 */
export function getHeatmapStyle(severity, isHealthy) {
  if (isHealthy) {
    return {
      backgroundColor: '#e1ded6',
      borderColor: 'rgba(15, 63, 73, 0.25)',
      color: '#0f3f49'
    };
  }
  const s = clamp(severity, 0, 1);
  // Concrete #ece6df -> RGB(236, 230, 223)
  // Burgundy #7f0508 -> RGB(127, 5, 8)
  const r = Math.round(236 + s * (127 - 236));
  const g = Math.round(230 + s * (5 - 230));
  const b = Math.round(223 + s * (8 - 223));

  return {
    backgroundColor: `rgb(${r}, ${g}, ${b})`,
    borderColor: s > 0.5 ? '#7f0508' : 'rgba(127, 5, 8, 0.35)',
    color: s > 0.5 ? '#ece6df' : '#0f3f49'
  };
}

/**
 * AGENT 1 (Sentinel) + AGENT 2 (Financial Analyst) + AGENT 3 (Scenario Planner) per SKU-Region lane
 */
export function evaluateLane(lane, levers, currentStockOverride, weights = { cost: 60, sla: 40 }, freightRates = {}) {
  const {
    disruptionDays = 0,       // 0 to +15 extra lead-time days
    demandSurgePct = 0,       // -30% to +80%
    zScore = 1.65,            // Safety stock z-multiplier (default 1.65)
    supplierReliabilityPct = 100, // 40% to 100% relative reliability
    freightMultiplier = 1.0   // 0.8x to 2.5x
  } = levers;

  // Effective daily demand (d) and std dev (sigma_d)
  const dMultiplier = Math.max(0.1, 1 + demandSurgePct / 100);
  const d = lane.daily_demand * dMultiplier;
  const sigma_d = lane.sigma_d * dMultiplier;

  // Effective reliability penalty adds lead time variance when supplier reliability drops below baseline
  const reliabilityFactor = clamp(supplierReliabilityPct / 100, 0.3, 1.2);
  const reliabilityExtraDays = (1 - reliabilityFactor) * 6.0;

  // Effective lead time L in days
  const L = Math.max(0.5, lane.base_lead_time + disruptionDays + reliabilityExtraDays);

  // Safety stock SS = z * sigma_d * sqrt(L)
  const SS = zScore * sigma_d * Math.sqrt(L);

  // Reorder point ROP = d*L + SS
  const ROP = d * L + SS;

  // Current stock on hand (drawn down by Replay Clock if active, plus in-transit pipeline erosion when extra disruption days delay expected arrivals)
  const baseStock = currentStockOverride !== undefined ? Math.max(0, currentStockOverride) : lane.initial_stock;
  const transitErosion = disruptionDays * d * 0.42;
  const stock = Math.max(0, baseStock - transitErosion);

  // Days of cover = stock / d
  const daysOfCover = d > 0 ? stock / d : 999;

  // Severity s = clamp(1 - stock/ROP, 0, 1)
  const isHealthy = stock > ROP;
  const severity = isHealthy ? 0 : clamp(1 - stock / Math.max(1, ROP), 0, 1);

  // Determine Alert Tier
  // Tier 3 EMERGENCY: days of cover < fastest mitigation lead time OR stock <= 0.5*SS
  // Tier 2 CRITICAL: stock <= SS
  // Tier 1 WATCH: stock <= ROP
  let tier = 0;
  let tierLabel = 'HEALTHY';
  let tierTriggerReason = 'Stock above Reorder Point (ROP)';

  if (daysOfCover < lane.fastest_mitigation_lead_time || stock <= 0.5 * SS) {
    tier = 3;
    tierLabel = 'TIER 3 · EMERGENCY';
    tierTriggerReason = daysOfCover < lane.fastest_mitigation_lead_time
      ? `Days of cover (${daysOfCover.toFixed(1)}d) < fastest mitigation lead time (${lane.fastest_mitigation_lead_time}d)`
      : `Stock (${Math.round(stock)}) <= 0.5 * Safety Stock (${Math.round(0.5 * SS)})`;
  } else if (stock <= SS) {
    tier = 2;
    tierLabel = 'TIER 2 · CRITICAL';
    tierTriggerReason = `Stock (${Math.round(stock)}) <= Safety Stock (${Math.round(SS)})`;
  } else if (stock <= ROP) {
    tier = 1;
    tierLabel = 'TIER 1 · WATCH';
    tierTriggerReason = `Stock (${Math.round(stock)}) <= Reorder Point (${Math.round(ROP)})`;
  }

  // Risk Model probability adjusted dynamically by extra lead time & delay variance
  const dynamicLateProb = clamp(
    lane.model_risk_prob + (disruptionDays * 0.028) + ((1 - reliabilityFactor) * 0.22),
    0.05,
    0.99
  );

  // Composite Alert Score (0-100) combining severity and ML late delivery risk probability
  const alertScore = Math.round((severity * 0.72 + dynamicLateProb * 0.28) * 100);

  // AGENT 2: FINANCIAL ANALYST FORMULAS
  // Shortfall units during lead time = max(0, d*L - stock)
  const shortfallUnits = Math.max(0, d * L - stock);
  const orderQtyNeeded = Math.max(Math.round(ROP - stock + d * 3), Math.round(d * 5));

  // Revenue at Risk = max(0, d*L - stock) * unit price
  const revenueAtRisk = shortfallUnits * lane.unit_price;

  // Lost Margin = Revenue at Risk * margin_ratio
  const lostMargin = revenueAtRisk * lane.margin_ratio;

  // Value of orders expected late = (d * L * unit_price) * dynamicLateProb (when disrupted or below ROP)
  const activePipelineOrderValue = d * L * lane.unit_price;
  const lateOrderExposure = isHealthy
    ? activePipelineOrderValue * lane.empirical_late_rate * 0.15
    : activePipelineOrderValue * dynamicLateProb;

  // SLA penalty = penalty rate * value of orders expected late
  const slaPenalty = lane.sla_penalty_rate * lateOrderExposure;

  // AGENT 3: SCENARIO PLANNER — Compare 4 Mitigation Options
  const baseFreightPerUnit = (freightRates[lane.dominant_ship_mode]?.base_per_unit || 4.2) +
                             (freightRates[lane.dominant_ship_mode]?.handling_per_unit || 1.1);
  const baselineShippingCost = orderQtyNeeded * baseFreightPerUnit;

  const daysSavedAir = Math.min(L - 1.0, Math.max(2.5, L * 0.62));
  const daysSavedReroute = Math.min(L - 1.5, Math.max(1.5, L * 0.38));
  const daysSavedAltSupplier = Math.min(L - 1.2, Math.max(2.0, L * 0.48));

  const rawOptions = [
    {
      id: 'air_expedite',
      name: 'Air Expedite (Same-Day / Next-Flight Charter)',
      shortName: 'Air Expedite',
      hubUsed: lane.warehouse_hub,
      supplierUsed: lane.primary_supplier,
      daysSaved: Number(daysSavedAir.toFixed(1)),
      effectiveLeadTime: Number(Math.max(1.0, L - daysSavedAir).toFixed(1)),
      freightPerUnit: 19.8 * freightMultiplier,
      expeditePremiumPerUnit: 9.2 * freightMultiplier,
      handlingPerUnit: 2.6,
      slaPreservationScore: 96,
      residualExposureRatio: 0.06,
      holdingDaysAdded: 1.0
    },
    {
      id: 'reroute_hub',
      name: `Re-route via ${lane.alternate_hub}`,
      shortName: 'Re-route Region/Hub',
      hubUsed: lane.alternate_hub,
      supplierUsed: lane.primary_supplier,
      daysSaved: Number(daysSavedReroute.toFixed(1)),
      effectiveLeadTime: Number(Math.max(1.5, L - daysSavedReroute).toFixed(1)),
      freightPerUnit: 7.4 * freightMultiplier,
      expeditePremiumPerUnit: 2.4 * freightMultiplier,
      handlingPerUnit: 1.65,
      slaPreservationScore: 82,
      residualExposureRatio: 0.22,
      holdingDaysAdded: 2.5
    },
    {
      id: 'alt_supplier',
      name: `Alternate Supplier (${lane.alternate_supplier})`,
      shortName: 'Alternate Supplier',
      hubUsed: lane.warehouse_hub,
      supplierUsed: lane.alternate_supplier,
      daysSaved: Number(daysSavedAltSupplier.toFixed(1)),
      effectiveLeadTime: Number(Math.max(1.2, L - daysSavedAltSupplier).toFixed(1)),
      freightPerUnit: 9.1 * freightMultiplier,
      expeditePremiumPerUnit: 3.6 * freightMultiplier,
      handlingPerUnit: 1.85,
      slaPreservationScore: 89,
      residualExposureRatio: 0.13,
      holdingDaysAdded: 3.0
    },
    {
      id: 'do_nothing',
      name: 'Do Nothing (Absorb Delay & Stockout Penalty)',
      shortName: 'Do Nothing',
      hubUsed: lane.warehouse_hub,
      supplierUsed: lane.primary_supplier,
      daysSaved: 0.0,
      effectiveLeadTime: Number(L.toFixed(1)),
      freightPerUnit: (freightRates[lane.dominant_ship_mode]?.base_per_unit || 4.2) * freightMultiplier,
      expeditePremiumPerUnit: 0.0,
      handlingPerUnit: freightRates[lane.dominant_ship_mode]?.handling_per_unit || 1.1,
      slaPreservationScore: Math.round(clamp((1 - severity) * 65, 8, 65)),
      residualExposureRatio: 1.0,
      holdingDaysAdded: 0.0
    }
  ];

  // Enrich each option with Landed Cost Delta, Extra Holding Cost, and resulting TCD
  const evaluatedOptions = rawOptions.map(opt => {
    const optionTotalFreight = orderQtyNeeded * (opt.freightPerUnit + opt.expeditePremiumPerUnit + opt.handlingPerUnit);
    // Landed Cost Delta = (freight + expedite premium + handling) of an option minus baseline
    const landedCostDelta = opt.id === 'do_nothing' ? 0 : Math.max(0, optionTotalFreight - baselineShippingCost);
    const extraHoldingCost = orderQtyNeeded * lane.holding_cost_per_unit_day * opt.holdingDaysAdded;

    const residualLostMargin = lostMargin * opt.residualExposureRatio;
    const residualSlaPenalty = slaPenalty * opt.residualExposureRatio;

    // Total Cost of Disruption (TCD) = lost margin + SLA penalties + mitigation cost + extra holding cost
    const totalCostOfDisruption = residualLostMargin + residualSlaPenalty + landedCostDelta + extraHoldingCost;

    return {
      ...opt,
      orderQtyNeeded,
      landedCostDelta: Math.round(landedCostDelta),
      extraHoldingCost: Math.round(extraHoldingCost),
      residualLostMargin: Math.round(residualLostMargin),
      residualSlaPenalty: Math.round(residualSlaPenalty),
      totalCostOfDisruption: Math.round(totalCostOfDisruption)
    };
  });

  // Weighted Ranking (Adjustable Cost vs SLA weights, default 60/40)
  const maxTcd = Math.max(...evaluatedOptions.map(o => o.totalCostOfDisruption), 1);
  const wCost = (weights.cost ?? 60) / 100;
  const wSla = (weights.sla ?? 40) / 100;

  evaluatedOptions.forEach(opt => {
    const costEfficiencyScore = clamp((1 - opt.totalCostOfDisruption / (maxTcd * 1.05)) * 100, 5, 100);
    // If lane is completely healthy (tier 0), Do Nothing is naturally preferred
    const compositeScore = isHealthy && opt.id === 'do_nothing'
      ? 98
      : (costEfficiencyScore * wCost) + (opt.slaPreservationScore * wSla);
    opt.costEfficiencyScore = Math.round(costEfficiencyScore);
    opt.compositeScore = Number(compositeScore.toFixed(1));
  });

  const rankedOptions = [...evaluatedOptions].sort((a, b) => b.compositeScore - a.compositeScore);
  const recommendedOption = rankedOptions[0];
  const doNothingOption = evaluatedOptions.find(o => o.id === 'do_nothing');

  // Two plain-sentence explanation for Scenario Planner
  const savingsVsDoNothing = Math.max(0, doNothingOption.totalCostOfDisruption - recommendedOption.totalCostOfDisruption);
  const recommendationRationale = isHealthy
    ? `Current inventory (${Math.round(stock)} units) comfortably exceeds the reorder point (${Math.round(ROP)} units), leaving zero stockout exposure across the ${L.toFixed(1)}-day lead time. Maintaining standard replenishment avoids unnecessary expedite premiums while keeping SLA compliance above target.`
    : `${recommendedOption.shortName} is recommended because it compresses effective lead time by ${recommendedOption.daysSaved} days (to ${recommendedOption.effectiveLeadTime}d) and achieves a ${recommendedOption.slaPreservationScore}% SLA preservation score under your ${weights.cost}/${weights.sla} Cost-to-SLA weighting. At a Landed Cost Delta of $${recommendedOption.landedCostDelta.toLocaleString()}, it reduces Total Cost of Disruption to $${recommendedOption.totalCostOfDisruption.toLocaleString()}—saving $${savingsVsDoNothing.toLocaleString()} in avoided lost margin and SLA penalties compared to doing nothing.`;

  // Unmitigated TCD (before agent intervention) vs Mitigated TCD (with recommended option)
  const unmitigatedTCD = doNothingOption.totalCostOfDisruption;
  const mitigatedTCD = recommendedOption.totalCostOfDisruption;

  // Alert Lead Time (days before stockout if unmitigated)
  const alertLeadTimeDays = Number(clamp(daysOfCover, 0.2, 30).toFixed(1));

  return {
    ...lane,
    d: Number(d.toFixed(2)),
    sigma_d: Number(sigma_d.toFixed(2)),
    L: Number(L.toFixed(2)),
    SS: Math.round(SS),
    ROP: Math.round(ROP),
    stock: Math.round(stock),
    daysOfCover: Number(daysOfCover.toFixed(1)),
    severity: Number(severity.toFixed(3)),
    isHealthy,
    tier,
    tierLabel,
    tierTriggerReason,
    dynamicLateProb: Number(dynamicLateProb.toFixed(3)),
    alertScore,
    shortfallUnits: Math.round(shortfallUnits),
    orderQtyNeeded,
    revenueAtRisk: Math.round(revenueAtRisk),
    lostMargin: Math.round(lostMargin),
    slaPenalty: Math.round(slaPenalty),
    landedCostDelta: isHealthy ? 0 : recommendedOption.landedCostDelta,
    extraHoldingCost: isHealthy ? 0 : recommendedOption.extraHoldingCost,
    unmitigatedTCD: Math.round(unmitigatedTCD),
    mitigatedTCD: Math.round(mitigatedTCD),
    tcdSavings: Math.round(savingsVsDoNothing),
    options: rankedOptions,
    recommendedOption,
    recommendationRationale,
    alertLeadTimeDays
  };
}

/**
 * Evaluates the entire global network across all SKU-Region lanes and computes aggregate KPIs & Region x Category Heatmap
 */
export function evaluateNetwork(data, levers, stockOverrides = {}, weights = { cost: 60, sla: 40 }) {
  if (!data || !data.lanes) return null;

  const evaluatedLanes = data.lanes.map(lane =>
    evaluateLane(lane, levers, stockOverrides[lane.id], weights, data.freight_rates)
  );

  // Aggregate KPIs
  let totalUnmitigatedTCD = 0;
  let totalMitigatedTCD = 0;
  let totalRevenueAtRisk = 0;
  let totalProtectedRevenue = 0;
  let totalLandedCostDelta = 0;
  let totalLostMargin = 0;
  let totalSlaPenalty = 0;

  let tier1Count = 0;
  let tier2Count = 0;
  let tier3Count = 0;
  let healthyCount = 0;

  evaluatedLanes.forEach(l => {
    totalUnmitigatedTCD += l.unmitigatedTCD;
    totalMitigatedTCD += l.mitigatedTCD;
    totalRevenueAtRisk += l.revenueAtRisk;
    const protectedRatio = 1 - (l.recommendedOption?.residualExposureRatio ?? 0);
    totalProtectedRevenue += l.revenueAtRisk * protectedRatio;
    totalLandedCostDelta += l.landedCostDelta;
    totalLostMargin += l.lostMargin;
    totalSlaPenalty += l.slaPenalty;

    if (l.tier === 3) tier3Count++;
    else if (l.tier === 2) tier2Count++;
    else if (l.tier === 1) tier1Count++;
    else healthyCount++;
  });

  const activeAlertsCount = tier1Count + tier2Count + tier3Count;

  // Network SLA Compliance Rate (%)
  const avgSeverity = evaluatedLanes.reduce((acc, l) => acc + l.severity, 0) / evaluatedLanes.length;
  const avgLateProb = evaluatedLanes.reduce((acc, l) => acc + l.dynamicLateProb, 0) / evaluatedLanes.length;
  const unmitigatedSlaCompliance = clamp(96.4 - (avgSeverity * 38) - (avgLateProb * 12), 42.0, 98.5);
  const mitigatedSlaCompliance = clamp(unmitigatedSlaCompliance + (avgSeverity * 29.5), unmitigatedSlaCompliance, 98.8);

  // Build Region x Category matrix for Heatmap
  const regions = Array.from(new Set(evaluatedLanes.map(l => l.region))).sort();
  const categories = Array.from(new Set(evaluatedLanes.map(l => l.category))).sort();

  const heatmapMatrix = {};
  regions.forEach(r => {
    heatmapMatrix[r] = {};
    categories.forEach(c => {
      const cellLanes = evaluatedLanes.filter(l => l.region === r && l.category === c);
      if (cellLanes.length === 0) {
        heatmapMatrix[r][c] = null;
      } else {
        // Worst tier and max severity in that cell
        const sortedCell = [...cellLanes].sort((a, b) => b.tier - a.tier || b.severity - a.severity);
        const primary = sortedCell[0];
        const cellRevRisk = cellLanes.reduce((s, x) => s + x.revenueAtRisk, 0);
        const cellTcd = cellLanes.reduce((s, x) => s + x.unmitigatedTCD, 0);
        heatmapMatrix[r][c] = {
          region: r,
          category: c,
          lanes: cellLanes,
          primaryLane: primary,
          maxSeverity: primary.severity,
          isHealthy: primary.isHealthy,
          maxTier: primary.tier,
          tierLabel: primary.tierLabel,
          revenueAtRisk: cellRevRisk,
          tcd: cellTcd
        };
      }
    });
  });

  return {
    lanes: evaluatedLanes,
    regions,
    categories,
    heatmapMatrix,
    kpis: {
      totalUnmitigatedTCD: Math.round(totalUnmitigatedTCD),
      totalMitigatedTCD: Math.round(totalMitigatedTCD),
      tcdSavedByAgents: Math.round(Math.max(0, totalUnmitigatedTCD - totalMitigatedTCD)),
      totalRevenueAtRisk: Math.round(totalRevenueAtRisk),
      totalProtectedRevenue: Math.round(totalProtectedRevenue),
      slaComplianceRate: Number(unmitigatedSlaCompliance.toFixed(1)),
      mitigatedSlaComplianceRate: Number(mitigatedSlaCompliance.toFixed(1)),
      totalLandedCostDelta: Math.round(totalLandedCostDelta),
      totalLostMargin: Math.round(totalLostMargin),
      totalSlaPenalty: Math.round(totalSlaPenalty),
      activeAlertsCount,
      tier1Count,
      tier2Count,
      tier3Count,
      healthyCount
    }
  };
}

/**
 * AGENT 4: EXECUTION AGENT — Generates Recipients, Outbox Emails, Draft POs, Slack/WhatsApp Messages, and Customer SLA Notices
 */
export function buildExecutionPayloads(lane, staffDirectory, sampleOrders = [], hodLimit = 25000) {
  const staff = staffDirectory[lane.region] || {
    supervisor: { name: 'Elena Vandenberg', email: 'supervisor@dataco-resilience.io', slack_handle: '@sup_ops' },
    manager: { name: 'Marcus Rojas', email: 'manager@dataco-resilience.io', slack_handle: '@mgr_ops' },
    hod: { name: 'Julian Costa', email: 'hod@dataco-resilience.io', slack_handle: '@hod_global' }
  };

  const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const rec = lane.recommendedOption;

  // Recipients by Tier
  // Tier 1 WATCH: Supervisor only (EMAIL)
  // Tier 2 CRITICAL: Supervisor + Manager (EMAIL + cost comparison table)
  // Tier 3 EMERGENCY: Supervisor + Manager + HOD (EMAIL + Draft PO + Slack/WhatsApp + Customer SLA notices + Escalation timer)
  let toList = [staff.supervisor.email];
  let ccList = [];
  if (lane.tier === 2) {
    ccList = [staff.manager.email];
  } else if (lane.tier === 3) {
    toList = [staff.supervisor.email, staff.manager.email];
    ccList = [staff.hod.email];
  }

  const costTableText = lane.options.map(o =>
    `  • ${o.shortName.padEnd(22)} | Landed Delta: $${o.landedCostDelta.toLocaleString().padStart(8)} | Days Saved: ${o.daysSaved}d | SLA Score: ${o.slaPreservationScore}% | Resulting TCD: $${o.totalCostOfDisruption.toLocaleString()}`
  ).join('\n');

  const emailSubject = `[${lane.tierLabel}] ${lane.region} · ${lane.product} (Stock: ${lane.stock} vs ROP: ${lane.ROP})`;
  const emailBody = `AUTONOMOUS CONTROL TOWER ALERT — ${lane.tierLabel}
Lane ID: ${lane.id} | Region: ${lane.region} | Category: ${lane.category}
Product: ${lane.product} | Primary Hub: ${lane.warehouse_hub}

1. TRIGGER & INVENTORY TELEMETRY (SENTINEL AGENT)
- Trigger Condition: ${lane.tierTriggerReason}
- On-Hand Stock: ${lane.stock} units | Reorder Point (ROP): ${lane.ROP} units | Safety Stock (SS): ${lane.SS} units
- Days of Cover: ${lane.daysOfCover} days | Effective Lead Time (L): ${lane.L} days | Daily Demand (d): ${lane.d} units/day
- ML Late Delivery Risk Probability: ${(lane.dynamicLateProb * 100).toFixed(1)}%

2. FINANCIAL EXPOSURE (ANALYST AGENT)
- Revenue at Risk: $${lane.revenueAtRisk.toLocaleString()}
- Expected SLA Penalty (${(lane.sla_penalty_rate * 100).toFixed(1)}%): $${lane.slaPenalty.toLocaleString()}
- Unmitigated Total Cost of Disruption (TCD): $${lane.unmitigatedTCD.toLocaleString()}

${lane.tier >= 2 ? `3. MITIGATION COST COMPARISON (SCENARIO PLANNER AGENT)\n${costTableText}\n\nRECOMMENDATION: ${rec.name}\n${lane.recommendationRationale}` : `3. RECOMMENDED ACTION\nMonitor replenishment lane closely; initiate standard reorder of ${lane.orderQtyNeeded} units if stock approaches Safety Stock (${lane.SS} units).`}
`;

  const poValue = Math.round(lane.orderQtyNeeded * lane.unit_price * 0.58 + rec.landedCostDelta);
  const requiresHodApproval = poValue > hodLimit;

  const draftPO = lane.tier === 3 ? {
    poNumber: `PO-EXP-${lane.id.split('-')[1]}-${Math.floor(1000 + Math.random() * 9000)}`,
    laneId: lane.id,
    region: lane.region,
    product: lane.product,
    category: lane.category,
    vendor: rec.supplierUsed,
    destinationHub: rec.hubUsed,
    mitigationMode: rec.name,
    quantity: lane.orderQtyNeeded,
    unitCost: Number((lane.unit_price * 0.58).toFixed(2)),
    landedCostDelta: rec.landedCostDelta,
    totalPoValue: poValue,
    hodLimit,
    requiresHodApproval,
    approverRole: requiresHodApproval ? `VP / HOD (${staff.hod.name})` : `Regional Manager (${staff.manager.name})`,
    status: 'PENDING_APPROVAL',
    createdAt: timestamp,
    leadTimeDays: rec.effectiveLeadTime,
    tcdProtected: lane.tcdSavings
  } : null;

  const secondChannelMsg = lane.tier === 3 ? {
    id: `MSG-${lane.id}-${Date.now()}`,
    channel: 'Slack #ops-emergency-warroom & WhatsApp Enterprise',
    handles: `${staff.supervisor.slack_handle} ${staff.manager.slack_handle} ${staff.hod.slack_handle}`,
    timestamp,
    region: lane.region,
    product: lane.product,
    text: `🚨 *[TIER 3 EMERGENCY]* *${lane.region}* — *${lane.product}*\n• *Cover:* ${lane.daysOfCover}d left (Stock: ${lane.stock}u vs SS: ${lane.SS}u)\n• *Rev at Risk:* $${lane.revenueAtRisk.toLocaleString()} | *Unmitigated TCD:* $${lane.unmitigatedTCD.toLocaleString()}\n• *AI Action:* Drafted *${draftPO.poNumber}* (${rec.shortName}, Qty ${lane.orderQtyNeeded}u, Value $${poValue.toLocaleString()}). ${requiresHodApproval ? `*HOD Approval Required (> $${hodLimit.toLocaleString()})*` : 'Awaiting Manager one-click sign-off.'}`
  } : null;

  // Affected customer SLA warning notices for Tier 3
  const matchingOrders = sampleOrders.filter(o => o.region === lane.region);
  const ordersToUse = matchingOrders.length > 0 ? matchingOrders.slice(0, 2) : [
    {
      order_id: `ORD-${78100 + parseInt(lane.id.replace(/\D/g, ''), 10)}`,
      region: lane.region,
      category: lane.category,
      product: lane.product,
      customer_city: lane.warehouse_hub.split(' ')[0],
      customer_country: lane.market,
      order_value: Math.round(lane.unit_price * 14),
      scheduled_days: Math.round(lane.scheduled_lead_time)
    }
  ];

  const customerNotices = lane.tier === 3 ? ordersToUse.map(ord => ({
    noticeId: `SLA-WARN-${ord.order_id}`,
    orderId: ord.order_id,
    region: lane.region,
    customerLocation: `${ord.customer_city}, ${ord.customer_country}`,
    product: lane.product,
    orderValue: ord.order_value,
    originalEtaDays: ord.scheduled_days,
    revisedEtaDays: rec.effectiveLeadTime,
    mitigationApplied: rec.shortName,
    status: 'DRAFT_READY',
    message: `Dear Valued Enterprise Partner (${ord.customer_city}), Priority fulfillment protection has been activated for Order ${ord.order_id} (${lane.product}). Due to a regional transit disruption (+${(lane.L - lane.base_lead_time).toFixed(1)}d lane variance), DataCo Resilience Engine has automatically re-routed your allocation via ${rec.shortName} from ${rec.hubUsed}, preserving your delivery window within ${rec.effectiveLeadTime} business days with zero SLA penalty.`
  })) : [];

  return {
    email: {
      id: `EML-${lane.id}-${Date.now()}`,
      laneId: lane.id,
      tier: lane.tier,
      tierLabel: lane.tierLabel,
      region: lane.region,
      product: lane.product,
      to: toList.join(', '),
      cc: ccList.length > 0 ? ccList.join(', ') : '—',
      subject: emailSubject,
      body: emailBody,
      timestamp,
      acknowledged: false
    },
    draftPO,
    secondChannelMsg,
    customerNotices
  };
}
