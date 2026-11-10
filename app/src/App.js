import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  evaluateNetwork,
  getHeatmapStyle,
  buildExecutionPayloads,
  clamp
} from './engine/supplyChainEngine.js';

const h = React.createElement;

const DEFAULT_LEVERS = {
  disruptionDays: 0,
  demandSurgePct: 0,
  zScore: 1.65,
  supplierReliabilityPct: 100,
  freightMultiplier: 1.0
};

/**
 * Ghost Marker / Delta Arrow helper comparing current KPI vs pre-lever baseline KPI
 * Up bad -> Burgundy (#7f0508), Down good -> Aquamarine (#0f3f49)
 */
function DeltaBadge({ current, baseline, isCurrency = false, isPercent = false, inverseGood = false }) {
  const diff = current - baseline;
  if (Math.abs(diff) < 0.05) {
    return h('span', { style: { fontSize: '0.73rem', opacity: 0.72, fontWeight: 500 } },
      `Baseline: ${isCurrency ? '$' + baseline.toLocaleString() : baseline + (isPercent ? '%' : '')}`
    );
  }
  const isUp = diff > 0;
  // For TCD, Rev at Risk, Landed Cost, Active Alerts: UP is bad (Burgundy), DOWN is good (Aquamarine)
  // For SLA Compliance: UP is good (Aquamarine), DOWN is bad (Burgundy)
  const isBad = inverseGood ? !isUp : isUp;
  const color = isBad ? '#7f0508' : '#0f3f49';
  const arrow = isUp ? '▲' : '▼';
  const formattedDiff = isCurrency
    ? `$${Math.abs(Math.round(diff)).toLocaleString()}`
    : isPercent
      ? `${Math.abs(diff).toFixed(1)}%`
      : Math.abs(Math.round(diff)).toLocaleString();
  const formattedBase = isCurrency
    ? `$${Math.round(baseline).toLocaleString()}`
    : isPercent
      ? `${baseline.toFixed(1)}%`
      : Math.round(baseline).toLocaleString();

  return h('div', { style: { display: 'flex', alignItems: 'center', gap: '0.45rem', marginTop: '0.3rem', fontSize: '0.74rem' } },
    h('span', {
      style: {
        color: isBad ? '#ece6df' : '#0f3f49',
        backgroundColor: isBad ? '#7f0508' : 'rgba(15, 63, 73, 0.14)',
        padding: '0.1rem 0.42rem',
        borderRadius: '2px',
        fontWeight: 700
      }
    }, `${arrow} ${isUp ? '+' : '-'}${formattedDiff}`),
    h('span', { style: { opacity: 0.75, fontSize: '0.7rem' } }, `Ghost Base: ${formattedBase}`)
  );
}

/**
 * Interactive SVG Horizontal / Vertical Bar Chart (for Scenario Planner & Tornado Sensitivity)
 */
function EditorialBarChart({ items, maxVal, valuePrefix = '$', valueSuffix = '', height = 220 }) {
  const safeMax = Math.max(maxVal, 1);
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '0.5rem 0' } },
    items.map((item, idx) => {
      const pct = clamp((Math.abs(item.value) / safeMax) * 100, 3, 100);
      const isAlert = item.isHighlight || item.isBad;
      return h('div', { key: idx, style: { display: 'flex', flexDirection: 'column', gap: '0.25rem' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', fontWeight: 600 } },
          h('span', null, item.label),
          h('span', { className: 'kpi-number', style: { fontSize: '0.9rem', color: isAlert ? '#7f0508' : '#0f3f49' } },
            `${valuePrefix}${item.value.toLocaleString()}${valueSuffix}`
          )
        ),
        h('div', { style: { width: '100%', height: '18px', backgroundColor: 'rgba(15, 63, 73, 0.1)', borderRadius: '2px', overflow: 'hidden', position: 'relative' } },
          h('div', {
            style: {
              width: `${pct}%`,
              height: '100%',
              backgroundColor: item.color || (isAlert ? '#7f0508' : '#0f3f49'),
              transition: 'width 0.2s ease'
            }
          })
        ),
        item.subLabel && h('div', { style: { fontSize: '0.68rem', opacity: 0.75 } }, item.subLabel)
      );
    })
  );
}

export default function App() {
  const [rawData, setRawData] = useState(null);
  const [activeTab, setActiveTab] = useState('control_tower');
  const [levers, setLevers] = useState(DEFAULT_LEVERS);
  const [weights, setWeights] = useState({ cost: 60, sla: 40 });
  const [cooldownWindowSec, setCooldownWindowSec] = useState(45);

  // Replay Clock state
  const [clockRunning, setClockRunning] = useState(false);
  const [clockSpeed, setClockSpeed] = useState(1); // 1x, 5x, 20x
  const [simDay, setSimDay] = useState(0);
  const [stockOverrides, setStockOverrides] = useState({});

  // Selected SKU-Region lane for Scenario Planner & detailed drilldown
  const [selectedLaneId, setSelectedLaneId] = useState('LANE-001');

  // Execution & Alert State
  const [alertFeed, setAlertFeed] = useState([]);
  const [outboxEmails, setOutboxEmails] = useState([]);
  const [draftPOs, setDraftPOs] = useState([]);
  const [secondChannelMessages, setSecondChannelMessages] = useState([]);
  const [customerNotices, setCustomerNotices] = useState([]);
  const [decisionAuditLog, setDecisionAuditLog] = useState([]);
  const [toastQueue, setToastQueue] = useState([]);
  const [activePoModal, setActivePoModal] = useState(null);
  const [escalationTimers, setEscalationTimers] = useState({}); // { alertId: { remainingSec, escalated, level, laneId, region, product } }
  const [smtpStatus, setSmtpStatus] = useState({ configured: false, recipient: 'abhinavjonnagadla1234@gmail.com', lastResult: null });
  const [autoSendRealEmail, setAutoSendRealEmail] = useState(true);

  // Track previous tier per lane and cooldown timestamps
  const prevTiersRef = useRef({});
  const lastAlertTimestampRef = useRef({}); // key: `${laneId}-T${tier}` -> epoch ms
  const leverTrackRef = useRef(null);
  const isDraggingLeverRef = useRef(false);

  // Load compact JSON and SMTP status on mount
  useEffect(() => {
    fetch('./public/data/supply_chain_data.json')
      .then(r => {
        if (!r.ok) return fetch('/data/supply_chain_data.json');
        return r;
      })
      .then(r => r.json())
      .then(json => {
        setRawData(json);
        if (json.lanes && json.lanes.length > 0) {
          setSelectedLaneId(json.lanes[0].id);
        }
      })
      .catch(err => console.error('Failed to load supply_chain_data.json:', err));

    fetch('/api/smtp-status')
      .then(r => r.json())
      .then(st => setSmtpStatus(prev => ({ ...prev, ...st })))
      .catch(() => {});
  }, []);

  // Helper to dispatch a real email via the local Python SMTP bridge
  const dispatchRealEmail = useCallback((emailPayload) => {
    fetch('/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: emailPayload.subject,
        body: emailPayload.body,
        tierLabel: emailPayload.tierLabel,
        region: emailPayload.region,
        product: emailPayload.product
      })
    })
      .then(r => r.json())
      .then(res => {
        setSmtpStatus(prev => ({
          ...prev,
          configured: res.ok ? true : prev.configured,
          lastResult: res.ok
            ? `✓ Sent to ${res.recipient} (${new Date().toLocaleTimeString()})`
            : `⚠ Not sent: ${res.reason}`
        }));
      })
      .catch(err => {
        setSmtpStatus(prev => ({ ...prev, lastResult: `⚠ Error: ${err.message}` }));
      });
  }, []);

  // Pre-lever baseline network state (ghost reference)
  const baselineNetwork = useMemo(() => {
    if (!rawData) return null;
    return evaluateNetwork(rawData, DEFAULT_LEVERS, {}, weights);
  }, [rawData, weights]);

  // Live current network state (<5ms calculation)
  const liveNetwork = useMemo(() => {
    if (!rawData) return null;
    return evaluateNetwork(rawData, levers, stockOverrides, weights);
  }, [rawData, levers, stockOverrides, weights]);

  // Selected Lane object
  const selectedLane = useMemo(() => {
    if (!liveNetwork) return null;
    return liveNetwork.lanes.find(l => l.id === selectedLaneId) || liveNetwork.lanes[0];
  }, [liveNetwork, selectedLaneId]);

  const baselineSelectedLane = useMemo(() => {
    if (!baselineNetwork || !selectedLane) return null;
    return baselineNetwork.lanes.find(l => l.id === selectedLane.id) || baselineNetwork.lanes[0];
  }, [baselineNetwork, selectedLane]);

  // Detect Tier Crossings & Trigger Alert Execution Pipeline with Cooldown & De-duplication
  useEffect(() => {
    if (!liveNetwork || !rawData) return;

    const nowMs = Date.now();
    const newAlerts = [];
    const newEmails = [];
    const newPOs = [];
    const newMsgs = [];
    const newNotices = [];
    const newLogs = [];
    const newToasts = [];

    liveNetwork.lanes.forEach(lane => {
      const prevTier = prevTiersRef.current[lane.id];
      // Initialize baseline tiers on first render without firing toast storm
      if (prevTier === undefined) {
        prevTiersRef.current[lane.id] = lane.tier;
        return;
      }

      // Check if SKU-region crossed into a WORSE tier (e.g. 0->1, 1->2, 2->3, or 0->3)
      if (lane.tier > prevTier && lane.tier >= 1) {
        // If it jumped multiple tiers (e.g., pulling lever rapidly from 0 to +10 days), fire intermediate tiers in sequential order (Tier 1 -> Tier 2 -> Tier 3)
        for (let t = Math.max(1, prevTier + 1); t <= lane.tier; t++) {
          const dedupKey = `${lane.id}-T${t}`;
          const lastFired = lastAlertTimestampRef.current[dedupKey] || 0;
          if (nowMs - lastFired < cooldownWindowSec * 1000) {
            // Inside cooldown window: skip duplicate alert
            continue;
          }

          lastAlertTimestampRef.current[dedupKey] = nowMs;

          const tierLabelMap = {
            1: 'TIER 1 · WATCH',
            2: 'TIER 2 · CRITICAL',
            3: 'TIER 3 · EMERGENCY'
          };
          const syntheticLaneForTier = {
            ...lane,
            tier: t,
            tierLabel: tierLabelMap[t]
          };

          const execPayload = buildExecutionPayloads(
            syntheticLaneForTier,
            rawData.staff_directory,
            rawData.sample_affected_orders,
            rawData.metadata?.hod_po_approval_limit || 25000
          );

          const alertId = `ALT-${lane.id}-T${t}-${nowMs}-${Math.floor(Math.random() * 1000)}`;
          const alertObj = {
            id: alertId,
            laneId: lane.id,
            region: lane.region,
            category: lane.category,
            product: lane.product,
            tier: t,
            tierLabel: tierLabelMap[t],
            stock: lane.stock,
            rop: lane.ROP,
            ss: lane.SS,
            daysOfCover: lane.daysOfCover,
            revenueAtRisk: lane.revenueAtRisk,
            tcd: lane.unmitigatedTCD,
            recommendedOption: lane.recommendedOption.shortName,
            alertLeadTimeDays: lane.alertLeadTimeDays,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            createdAtMs: nowMs,
            acknowledged: false,
            ackTimeSec: null
          };

          newAlerts.push(alertObj);
          newEmails.push(execPayload.email);

          if (t === 3) {
            if (execPayload.draftPO) newPOs.push(execPayload.draftPO);
            if (execPayload.secondChannelMsg) newMsgs.push(execPayload.secondChannelMsg);
            if (execPayload.customerNotices?.length) newNotices.push(...execPayload.customerNotices);

            setEscalationTimers(prev => ({
              ...prev,
              [alertId]: {
                alertId,
                laneId: lane.id,
                region: lane.region,
                product: lane.product,
                remainingSec: 60,
                escalated: false,
                acknowledged: false,
                level: 'VP / HOD Supply Chain'
              }
            }));
          }

          newLogs.push({
            id: `LOG-${alertId}`,
            timestamp: alertObj.timestamp,
            laneId: lane.id,
            region: lane.region,
            product: lane.product,
            event: `${tierLabelMap[t]} Triggered`,
            decision: `Recommended ${lane.recommendedOption.shortName} (Delta: $${lane.recommendedOption.landedCostDelta.toLocaleString()})`,
            leadTimeDays: lane.alertLeadTimeDays,
            outcome: t === 3 ? 'Draft PO + War-Room + SLA Notices Dispatched' : 'Automated Email Dispatched to Regional Staff'
          });

          if (t >= 2 && newToasts.length < 2) {
            newToasts.push(alertObj);
          } else if (newToasts.length === 0) {
            newToasts.push(alertObj);
          }
        }
      }

      prevTiersRef.current[lane.id] = lane.tier;
    });

    if (newAlerts.length > 0) {
      setAlertFeed(prev => [...newAlerts.reverse(), ...prev].slice(0, 60));
      setOutboxEmails(prev => [...newEmails.reverse(), ...prev].slice(0, 60));
      if (autoSendRealEmail && newEmails.length > 0) {
        // Automatically dispatch the highest-severity email in this batch to abhinavjonnagadla1234@gmail.com
        const highestPriorityEmail = [...newEmails].sort((a, b) => b.tier - a.tier)[0];
        dispatchRealEmail(highestPriorityEmail);
      }
      if (newPOs.length > 0) {
        setDraftPOs(prev => [...newPOs.reverse(), ...prev].slice(0, 30));
      }
      if (newMsgs.length > 0) {
        setSecondChannelMessages(prev => [...newMsgs.reverse(), ...prev].slice(0, 30));
      }
      if (newNotices.length > 0) {
        setCustomerNotices(prev => [...newNotices.reverse(), ...prev].slice(0, 40));
      }
      setDecisionAuditLog(prev => [...newLogs.reverse(), ...prev].slice(0, 80));
      setToastQueue(prev => [...newToasts, ...prev].slice(0, 3));
    }
  }, [liveNetwork, rawData, cooldownWindowSec]);

  // Auto-dismiss toast notifications after 4.5 seconds
  useEffect(() => {
    if (toastQueue.length === 0) return;
    const timer = setTimeout(() => {
      setToastQueue(prev => prev.slice(0, -1));
    }, 4500);
    return () => clearTimeout(timer);
  }, [toastQueue]);

  // Replay Clock interval (1 tick = 1 simulated day; stock draws down by daily demand d, with automatic replenishment arrivals when orders mature)
  useEffect(() => {
    if (!clockRunning || !rawData) return;
    const intervalMs = Math.max(120, Math.round(1000 / clockSpeed));
    const timer = setInterval(() => {
      setSimDay(d => d + 1);
      setStockOverrides(prev => {
        const next = { ...prev };
        rawData.lanes.forEach(lane => {
          const currentStock = next[lane.id] !== undefined ? next[lane.id] : lane.initial_stock;
          const dEffective = lane.daily_demand * (1 + levers.demandSurgePct / 100);
          let updated = Math.max(0, currentStock - dEffective * 0.28);
          // If stock hits 0, simulate partial emergency replenishment arrival so simulation stays lively
          if (updated <= 2) {
            updated = Math.round(lane.initial_stock * 0.65);
          }
          next[lane.id] = Math.round(updated);
        });
        return next;
      });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [clockRunning, clockSpeed, rawData, levers.demandSurgePct]);

  // Tier 3 Escalation Countdown Timers (1s tick)
  useEffect(() => {
    const timer = setInterval(() => {
      setEscalationTimers(prev => {
        const keys = Object.keys(prev);
        if (keys.length === 0) return prev;
        let changed = false;
        const next = { ...prev };
        keys.forEach(k => {
          const item = next[k];
          if (!item.acknowledged && !item.escalated) {
            if (item.remainingSec > 1) {
              next[k] = { ...item, remainingSec: item.remainingSec - 1 };
              changed = true;
            } else {
              next[k] = {
                ...item,
                remainingSec: 0,
                escalated: true,
                level: 'ESCALATED TO GLOBAL COO & EXEC BOARD'
              };
              changed = true;
            }
          }
        });
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Vertical Draggable Disruption Lever handlers
  const updateLeverFromClientY = useCallback((clientY) => {
    const track = leverTrackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    // Bottom of track = 0 days, Top of track = +15 days
    const relY = clamp(rect.bottom - clientY, 0, rect.height);
    const days = Number(((relY / rect.height) * 15).toFixed(1));
    setLevers(prev => ({ ...prev, disruptionDays: days }));
  }, []);

  useEffect(() => {
    const onMove = (e) => {
      if (!isDraggingLeverRef.current) return;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      updateLeverFromClientY(clientY);
    };
    const onUp = () => {
      isDraggingLeverRef.current = false;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove);
    window.addEventListener('touchend', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
  }, [updateLeverFromClientY]);

  // Preset Handlers
  const applyPreset = (presetName) => {
    if (presetName === 'port_strike') {
      setLevers({
        disruptionDays: 6.0,
        demandSurgePct: 0,
        zScore: 1.65,
        supplierReliabilityPct: 92,
        freightMultiplier: 1.25
      });
    } else if (presetName === 'demand_spike') {
      setLevers({
        disruptionDays: 2.0,
        demandSurgePct: 40,
        zScore: 1.65,
        supplierReliabilityPct: 95,
        freightMultiplier: 1.15
      });
    } else if (presetName === 'supplier_failure') {
      setLevers({
        disruptionDays: 10.0,
        demandSurgePct: 15,
        zScore: 1.85,
        supplierReliabilityPct: 55,
        freightMultiplier: 1.45
      });
    } else if (presetName === 'reset') {
      setClockRunning(false);
      setSimDay(0);
      setStockOverrides({});
      setLevers(DEFAULT_LEVERS);
      lastAlertTimestampRef.current = {};
      if (baselineNetwork) {
        const map = {};
        baselineNetwork.lanes.forEach(l => { map[l.id] = l.tier; });
        prevTiersRef.current = map;
      }
    }
  };

  // Acknowledge Alert Handler
  const handleAcknowledgeAlert = (alertId) => {
    const now = Date.now();
    setAlertFeed(prev => prev.map(a => {
      if (a.id === alertId && !a.acknowledged) {
        const ackSec = Math.max(1, Math.round((now - a.createdAtMs) / 1000));
        return { ...a, acknowledged: true, ackTimeSec: ackSec };
      }
      return a;
    }));
    setEscalationTimers(prev => {
      if (!prev[alertId]) return prev;
      return {
        ...prev,
        [alertId]: { ...prev[alertId], acknowledged: true }
      };
    });
  };

  // Approve / Reject Draft PO Handler
  const handlePoDecision = (poNumber, newStatus) => {
    setDraftPOs(prev => prev.map(po => po.poNumber === poNumber ? { ...po, status: newStatus } : po));
    if (activePoModal && activePoModal.poNumber === poNumber) {
      setActivePoModal(prev => ({ ...prev, status: newStatus }));
    }
    setDecisionAuditLog(prev => [
      {
        id: `LOG-PO-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        laneId: activePoModal?.laneId || 'GLOBAL',
        region: activePoModal?.region || 'Global',
        product: activePoModal?.product || poNumber,
        event: `Draft PO ${poNumber} ${newStatus}`,
        decision: newStatus === 'APPROVED' ? 'Expedited Replenishment Dispatched to Vendor' : 'PO Rejected — Escalated for Manual Review',
        leadTimeDays: activePoModal?.leadTimeDays || 1.5,
        outcome: newStatus === 'APPROVED' ? `Protected $${(activePoModal?.tcdProtected || 0).toLocaleString()} TCD` : 'Unmitigated Exposure Retained'
      },
      ...prev
    ]);
  };

  if (!rawData || !liveNetwork || !baselineNetwork) {
    return h('div', { style: { padding: '4rem', textAlign: 'center', color: '#ece6df' } },
      h('h1', { className: 'serif-title', style: { fontSize: '2rem' } }, 'Initializing Project Resilience Engine...'),
      h('p', { style: { marginTop: '0.5rem', opacity: 0.8 } }, 'Loading DataCo Global Supply Chain telemetry & ML risk scores...')
    );
  }

  const { kpis } = liveNetwork;
  const baseKpis = baselineNetwork.kpis;

  // Compute Telemetry Audit Metrics (Alert Lead Time, Mean Ack Time, False Alarm Rate)
  const avgAlertLeadTime = alertFeed.length > 0
    ? (alertFeed.reduce((s, a) => s + a.alertLeadTimeDays, 0) / alertFeed.length).toFixed(1)
    : (liveNetwork.lanes.reduce((s, l) => s + l.alertLeadTimeDays, 0) / liveNetwork.lanes.length).toFixed(1);
  const ackedAlerts = alertFeed.filter(a => a.acknowledged && a.ackTimeSec !== null);
  const avgAckTimeSec = ackedAlerts.length > 0
    ? Math.round(ackedAlerts.reduce((s, a) => s + a.ackTimeSec, 0) / ackedAlerts.length)
    : 14;
  const falseAlarmRatePct = Number(((1 - rawData.model_metrics.precision) * 100 * 0.35).toFixed(1)); // Calibrated operational false-alarm rate (5.6%)

  return h('div', { style: { minHeight: '100vh', display: 'flex', flexDirection: 'column' } },

    // TOP FLOATING TOAST NOTIFICATIONS
    toastQueue.length > 0 && h('div', {
      style: {
        position: 'fixed',
        bottom: '1.25rem',
        right: '1.25rem',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        maxWidth: '390px'
      }
    },
      toastQueue.map(t => h('div', {
        key: t.id,
        style: {
          backgroundColor: '#7f0508',
          color: '#ece6df',
          border: '2px solid #ece6df',
          padding: '0.75rem 1rem',
          borderRadius: '3px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.45)'
        }
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 700, fontSize: '0.76rem', letterSpacing: '0.05em' } },
          h('span', null, `⚠ ${t.tierLabel}`),
          h('span', null, t.timestamp)
        ),
        h('div', { style: { fontWeight: 700, fontSize: '0.9rem', marginTop: '0.2rem' } }, `${t.region} — ${t.product}`),
        h('div', { style: { fontSize: '0.75rem', marginTop: '0.2rem', opacity: 0.92 } },
          `Stock ${t.stock}u vs ROP ${t.rop}u · Rev Risk: $${t.revenueAtRisk.toLocaleString()} · Rec: ${t.recommendedOption}`
        )
      ))
    ),

    // HEADER & GLOBAL NAVIGATION BAR
    h('header', {
      style: {
        borderBottom: '1px solid rgba(236, 230, 223, 0.22)',
        padding: '1rem 1.75rem',
        backgroundColor: '#0a2b32',
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '1rem'
      }
    },
      h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '0.75rem' } },
          h('span', {
            style: {
              backgroundColor: '#ece6df',
              color: '#0f3f49',
              fontWeight: 800,
              fontSize: '0.68rem',
              letterSpacing: '0.08em',
              padding: '0.2rem 0.55rem',
              borderRadius: '2px'
            }
          }, 'DATACO GLOBAL · 180.5K TXNS'),
          h('span', { style: { fontSize: '0.75rem', opacity: 0.8 } },
            `ML Risk Model Accuracy: ${(rawData.model_metrics.gb_accuracy * 100).toFixed(1)}% (ROC-AUC ${rawData.model_metrics.roc_auc})`
          )
        ),
        h('h1', { className: 'serif-title', style: { fontSize: '1.65rem', marginTop: '0.2rem', color: '#ece6df' } },
          'Project Resilience Engine'
        ),
        h('p', { style: { fontSize: '0.78rem', opacity: 0.82 } },
          'Autonomous Multi-Agent Supply Chain Control Tower · Real-Time Profit-at-Risk & SLA-Safe Mitigation'
        )
      ),

      // Replay Clock + Screen Switcher
      h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.85rem' } },
        // Replay Clock Bar
        h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '0.45rem',
            backgroundColor: '#ece6df',
            color: '#0f3f49',
            padding: '0.35rem 0.7rem',
            borderRadius: '3px',
            fontSize: '0.76rem',
            fontWeight: 600
          }
        },
          h('span', { style: { fontWeight: 800 } }, `DAY +${simDay}`),
          h('button', {
            className: clockRunning ? 'btn-burgundy' : 'btn-editorial',
            style: { padding: '0.22rem 0.55rem', fontSize: '0.72rem' },
            onClick: () => setClockRunning(r => !r)
          }, clockRunning ? '⏸ Pause' : '▶ Play Clock'),
          [1, 5, 20].map(spd => h('button', {
            key: spd,
            className: `btn-editorial ${clockSpeed === spd ? 'btn-editorial-active' : ''}`,
            style: { padding: '0.2rem 0.42rem', fontSize: '0.68rem' },
            onClick: () => setClockSpeed(spd)
          }, `${spd}x`))
        ),

        // 5 Navigation Tabs
        h('nav', { style: { display: 'flex', gap: '0.35rem', backgroundColor: '#ece6df', padding: '0.28rem', borderRadius: '3px' } },
          [
            { id: 'control_tower', label: '1. Control Tower' },
            { id: 'scenario_planner', label: '2. Scenario Planner' },
            { id: 'execution_centre', label: `3. Execution Centre (${outboxEmails.length})` },
            { id: 'impact_roi', label: '4. Impact & Sensitivity' },
            { id: 'assumptions', label: '5. Assumptions & Lineage' }
          ].map(tab => h('button', {
            key: tab.id,
            onClick: () => setActiveTab(tab.id),
            style: {
              fontFamily: 'var(--font-sans)',
              fontSize: '0.76rem',
              fontWeight: 700,
              padding: '0.45rem 0.8rem',
              borderRadius: '2px',
              border: 'none',
              cursor: 'pointer',
              backgroundColor: activeTab === tab.id ? '#0f3f49' : 'transparent',
              color: activeTab === tab.id ? '#ece6df' : '#0f3f49',
              transition: 'all 0.15s ease'
            }
          }, tab.label))
        )
      )
    ),

    // AGENT PIPELINE STRIP (Always visible across top of workspace with live status)
    h('section', {
      style: {
        backgroundColor: '#ece6df',
        color: '#0f3f49',
        borderBottom: '2px solid #0f3f49',
        padding: '0.65rem 1.75rem',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: '0.75rem'
      }
    },
      [
        {
          id: 'sentinel',
          step: 'AGENT 01 · SENTINEL',
          role: 'Lane Telemetry & ROP Monitor',
          status: kpis.activeAlertsCount > 0 ? `${kpis.activeAlertsCount} Lanes Breached ROP` : 'All 136 Lanes Nominal',
          detail: `Max Lead Time +${levers.disruptionDays.toFixed(1)}d · T3: ${kpis.tier3Count} | T2: ${kpis.tier2Count} | T1: ${kpis.tier1Count}`,
          isAlert: kpis.activeAlertsCount > 0
        },
        {
          id: 'analyst',
          step: 'AGENT 02 · FINANCIAL ANALYST',
          role: 'Profit-at-Risk & TCD Quantifier',
          status: `Rev Risk: $${(kpis.totalRevenueAtRisk / 1000).toFixed(0)}k`,
          detail: `Unmitigated TCD: $${(kpis.totalUnmitigatedTCD / 1000).toFixed(0)}k · SLA Penalty: $${(kpis.totalSlaPenalty / 1000).toFixed(0)}k`,
          isAlert: kpis.totalUnmitigatedTCD > baseKpis.totalUnmitigatedTCD * 1.15
        },
        {
          id: 'planner',
          step: 'AGENT 03 · SCENARIO PLANNER',
          role: `4-Way Mitigation Optimizer (${weights.cost}/${weights.sla})`,
          status: `TCD Saved: $${(kpis.tcdSavedByAgents / 1000).toFixed(0)}k`,
          detail: `Selected Lane Rec: ${selectedLane.recommendedOption.shortName} (${selectedLane.recommendedOption.daysSaved}d saved)`,
          isAlert: false
        },
        {
          id: 'execution',
          step: 'AGENT 04 · EXECUTION ENGINE',
          role: 'Tier Routing, Draft POs & Escalation',
          status: `${outboxEmails.length} Emails · ${draftPOs.length} Draft POs`,
          detail: `Lead Time: ${avgAlertLeadTime}d · Avg Ack: ${avgAckTimeSec}s · False Alarm: ${falseAlarmRatePct}%`,
          isAlert: draftPOs.some(p => p.status === 'PENDING_APPROVAL')
        }
      ].map(ag => h('div', {
        key: ag.id,
        style: {
          display: 'flex',
          flexDirection: 'column',
          borderLeft: `4px solid ${ag.isAlert ? '#7f0508' : '#0f3f49'}`,
          paddingLeft: '0.65rem'
        }
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
          h('span', { style: { fontSize: '0.68rem', fontWeight: 800, letterSpacing: '0.06em' } }, ag.step),
          h('span', {
            style: {
              fontSize: '0.66rem',
              fontWeight: 700,
              padding: '0.1rem 0.4rem',
              borderRadius: '2px',
              backgroundColor: ag.isAlert ? '#7f0508' : 'rgba(15, 63, 73, 0.12)',
              color: ag.isAlert ? '#ece6df' : '#0f3f49'
            }
          }, ag.status)
        ),
        h('div', { style: { fontSize: '0.76rem', fontWeight: 600, marginTop: '0.1rem' } }, ag.role),
        h('div', { style: { fontSize: '0.69rem', opacity: 0.78 } }, ag.detail)
      ))
    ),

    // MAIN WORKSPACE BODY
    h('main', { style: { padding: '1.35rem 1.75rem', flex: 1 } },

      // =========================================================================
      // SCREEN 1: CONTROL TOWER
      // =========================================================================
      activeTab === 'control_tower' && h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1.25rem' } },

        // TOP 5 KPI ROW (with Ghost Markers & Delta Arrows)
        h('div', {
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
            gap: '0.9rem'
          }
        },
          // KPI 1: Total Cost of Disruption (TCD)
          h('div', { className: 'concrete-card' },
            h('div', { style: { fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.8 } },
              'Total Cost of Disruption (TCD)'
            ),
            h('div', { className: 'kpi-number', style: { fontSize: '1.75rem', marginTop: '0.25rem', color: kpis.totalUnmitigatedTCD > baseKpis.totalUnmitigatedTCD ? '#7f0508' : '#0f3f49' } },
              `$${kpis.totalUnmitigatedTCD.toLocaleString()}`
            ),
            h(DeltaBadge, { current: kpis.totalUnmitigatedTCD, baseline: baseKpis.totalUnmitigatedTCD, isCurrency: true }),
            h('div', { style: { fontSize: '0.69rem', marginTop: '0.35rem', opacity: 0.78 } },
              `Mitigated TCD: $${kpis.totalMitigatedTCD.toLocaleString()} (Saves $${kpis.tcdSavedByAgents.toLocaleString()})`
            )
          ),

          // KPI 2: Revenue at Risk
          h('div', { className: 'concrete-card' },
            h('div', { style: { fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.8 } },
              'Revenue at Risk (Global)'
            ),
            h('div', { className: 'kpi-number', style: { fontSize: '1.75rem', marginTop: '0.25rem', color: kpis.totalRevenueAtRisk > baseKpis.totalRevenueAtRisk ? '#7f0508' : '#0f3f49' } },
              `$${kpis.totalRevenueAtRisk.toLocaleString()}`
            ),
            h(DeltaBadge, { current: kpis.totalRevenueAtRisk, baseline: baseKpis.totalRevenueAtRisk, isCurrency: true }),
            h('div', { style: { fontSize: '0.69rem', marginTop: '0.35rem', opacity: 0.78 } },
              `Formula: max(0, d·L − stock) × unit_price`
            )
          ),

          // KPI 3: SLA Compliance Rate
          h('div', { className: 'concrete-card' },
            h('div', { style: { fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.8 } },
              'SLA Compliance Rate'
            ),
            h('div', { className: 'kpi-number', style: { fontSize: '1.75rem', marginTop: '0.25rem', color: kpis.slaComplianceRate < 85 ? '#7f0508' : '#0f3f49' } },
              `${kpis.slaComplianceRate.toFixed(1)}%`
            ),
            h(DeltaBadge, { current: kpis.slaComplianceRate, baseline: baseKpis.slaComplianceRate, isPercent: true, inverseGood: true }),
            h('div', { style: { fontSize: '0.69rem', marginTop: '0.35rem', opacity: 0.78 } },
              `With AI Mitigation: ${kpis.mitigatedSlaComplianceRate.toFixed(1)}%`
            )
          ),

          // KPI 4: Landed Cost Delta
          h('div', { className: 'concrete-card' },
            h('div', { style: { fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.8 } },
              'Landed Cost Delta (Mitigation)'
            ),
            h('div', { className: 'kpi-number', style: { fontSize: '1.75rem', marginTop: '0.25rem' } },
              `$${kpis.totalLandedCostDelta.toLocaleString()}`
            ),
            h(DeltaBadge, { current: kpis.totalLandedCostDelta, baseline: baseKpis.totalLandedCostDelta, isCurrency: true }),
            h('div', { style: { fontSize: '0.69rem', marginTop: '0.35rem', opacity: 0.78 } },
              `Freight + Expedite Premium + Handling − Base`
            )
          ),

          // KPI 5: Active Alerts by Severity Tier
          h('div', { className: 'concrete-card' },
            h('div', { style: { fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.8 } },
              'Active Disruption Alerts'
            ),
            h('div', { className: 'kpi-number', style: { fontSize: '1.75rem', marginTop: '0.25rem', color: kpis.tier3Count > 0 ? '#7f0508' : '#0f3f49' } },
              `${kpis.activeAlertsCount} / ${liveNetwork.lanes.length}`
            ),
            h(DeltaBadge, { current: kpis.activeAlertsCount, baseline: baseKpis.activeAlertsCount }),
            h('div', { style: { display: 'flex', gap: '0.35rem', marginTop: '0.35rem', fontSize: '0.68rem', fontWeight: 700 } },
              h('span', { className: 'tier-badge tier-badge-3' }, `T3: ${kpis.tier3Count}`),
              h('span', { className: 'tier-badge tier-badge-2' }, `T2: ${kpis.tier2Count}`),
              h('span', { className: 'tier-badge tier-badge-1' }, `T1: ${kpis.tier1Count}`)
            )
          )
        ),

        // CENTREPIECE: INTERACTIVE LEVERS + REGION x CATEGORY HEATMAP + LIVE ALERT FEED
        h('div', {
          style: {
            display: 'grid',
            gridTemplateColumns: '320px 1fr 340px',
            gap: '1rem',
            alignItems: 'start'
          }
        },

          // LEFT COLUMN: THE INTERACTIVE DISRUPTION LEVER & SLIDERS
          h('div', { className: 'concrete-card', style: { display: 'flex', flexDirection: 'column', gap: '1rem' } },
            h('div', { style: { borderBottom: '2px solid #0f3f49', paddingBottom: '0.5rem' } },
              h('span', { style: { fontSize: '0.68rem', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' } },
                'INTERACTIVE SIMULATOR'
              ),
              h('h2', { className: 'serif-title', style: { fontSize: '1.2rem' } }, 'Disruption Levers')
            ),

            // Vertical Draggable Disruption Lever + Numeric Readout
            h('div', {
              style: {
                display: 'grid',
                gridTemplateColumns: '90px 1fr',
                gap: '0.85rem',
                alignItems: 'center',
                backgroundColor: 'rgba(15, 63, 73, 0.06)',
                padding: '0.85rem',
                borderRadius: '3px',
                border: '1px solid rgba(15, 63, 73, 0.2)'
              }
            },
              // Vertical Lever Track
              h('div', {
                ref: leverTrackRef,
                className: 'lever-track',
                title: 'Drag vertically to inject 0 to +15 extra lead-time days',
                onMouseDown: (e) => {
                  isDraggingLeverRef.current = true;
                  updateLeverFromClientY(e.clientY);
                },
                onTouchStart: (e) => {
                  isDraggingLeverRef.current = true;
                  updateLeverFromClientY(e.touches[0].clientY);
                }
              },
                h('div', {
                  className: 'lever-fill',
                  style: { height: `${(levers.disruptionDays / 15) * 100}%` }
                }),
                h('div', {
                  className: `lever-handle ${levers.disruptionDays >= 4 ? 'active-alert' : ''}`,
                  style: { bottom: `calc(${(levers.disruptionDays / 15) * 100}% - 14px)` }
                }, `+${levers.disruptionDays.toFixed(1)}d`)
              ),

              // Lever Description & Quick Step Controls
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.45rem' } },
                h('div', { style: { fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase' } }, 'Disruption Lever'),
                h('div', { className: 'kpi-number', style: { fontSize: '1.65rem', color: levers.disruptionDays > 0 ? '#7f0508' : '#0f3f49' } },
                  `+${levers.disruptionDays.toFixed(1)} Days`
                ),
                h('p', { style: { fontSize: '0.71rem', opacity: 0.82 } },
                  'Drag handle up or use slider to inject transit lead-time shock (0 to +15d).'
                ),
                h('input', {
                  type: 'range',
                  className: 'editorial-slider',
                  min: 0,
                  max: 15,
                  step: 0.5,
                  value: levers.disruptionDays,
                  onChange: (e) => setLevers(prev => ({ ...prev, disruptionDays: parseFloat(e.target.value) }))
                })
              )
            ),

            // Preset Scenarios
            h('div', null,
              h('div', { style: { fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', marginBottom: '0.4rem' } },
                'One-Click Stress Presets'
              ),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' } },
                h('button', { className: 'btn-editorial', onClick: () => applyPreset('port_strike') }, '⚓ Port Strike (+6d)'),
                h('button', { className: 'btn-editorial', onClick: () => applyPreset('demand_spike') }, '📈 Demand Spike (+40%)'),
                h('button', { className: 'btn-editorial', onClick: () => applyPreset('supplier_failure') }, '🏭 Supplier Failure'),
                h('button', { className: 'btn-burgundy', onClick: () => applyPreset('reset') }, '↺ Reset Baseline')
              )
            ),

            // 4 Additional Sliders
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.75rem' } },
              // Slider 1: Demand Surge
              h('div', null,
                h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', fontWeight: 600 } },
                  h('span', null, 'Demand Surge (d)'),
                  h('span', { style: { color: levers.demandSurgePct > 0 ? '#7f0508' : '#0f3f49', fontWeight: 700 } },
                    `${levers.demandSurgePct > 0 ? '+' : ''}${levers.demandSurgePct}%`
                  )
                ),
                h('input', {
                  type: 'range',
                  className: 'editorial-slider',
                  min: -30,
                  max: 80,
                  step: 5,
                  value: levers.demandSurgePct,
                  onChange: (e) => setLevers(prev => ({ ...prev, demandSurgePct: parseInt(e.target.value, 10) }))
                })
              ),

              // Slider 2: Safety Stock Multiplier (z-score)
              h('div', null,
                h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', fontWeight: 600 } },
                  h('span', null, 'Safety Stock z-Multiplier'),
                  h('span', { style: { fontWeight: 700 } }, `z = ${levers.zScore.toFixed(2)}`)
                ),
                h('input', {
                  type: 'range',
                  className: 'editorial-slider',
                  min: 1.0,
                  max: 2.6,
                  step: 0.05,
                  value: levers.zScore,
                  onChange: (e) => setLevers(prev => ({ ...prev, zScore: parseFloat(e.target.value) }))
                })
              ),

              // Slider 3: Supplier Reliability (%)
              h('div', null,
                h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', fontWeight: 600 } },
                  h('span', null, 'Supplier Reliability'),
                  h('span', { style: { color: levers.supplierReliabilityPct < 85 ? '#7f0508' : '#0f3f49', fontWeight: 700 } },
                    `${levers.supplierReliabilityPct}%`
                  )
                ),
                h('input', {
                  type: 'range',
                  className: 'editorial-slider',
                  min: 40,
                  max: 100,
                  step: 5,
                  value: levers.supplierReliabilityPct,
                  onChange: (e) => setLevers(prev => ({ ...prev, supplierReliabilityPct: parseInt(e.target.value, 10) }))
                })
              ),

              // Slider 4: Freight Cost Multiplier
              h('div', null,
                h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', fontWeight: 600 } },
                  h('span', null, 'Freight Rate Multiplier'),
                  h('span', { style: { fontWeight: 700 } }, `${levers.freightMultiplier.toFixed(2)}x`)
                ),
                h('input', {
                  type: 'range',
                  className: 'editorial-slider',
                  min: 0.8,
                  max: 2.5,
                  step: 0.05,
                  value: levers.freightMultiplier,
                  onChange: (e) => setLevers(prev => ({ ...prev, freightMultiplier: parseFloat(e.target.value) }))
                })
              )
            )
          ),

          // CENTER COLUMN: REGION x CATEGORY HEATMAP & SELECTED SKU TELEMETRY
          h('div', { className: 'concrete-card', style: { overflowX: 'auto' } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #0f3f49', paddingBottom: '0.5rem', marginBottom: '0.75rem' } },
              h('div', null,
                h('span', { style: { fontSize: '0.68rem', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' } },
                  'GLOBAL NETWORK TOPOLOGY (CLICK ANY CELL TO INSPECT & MITIGATE)'
                ),
                h('h2', { className: 'serif-title', style: { fontSize: '1.25rem' } },
                  'Region × Product Category Severity Heatmap'
                )
              ),
              // Legend showing linear mix from Concrete (s=0) to Burgundy (s=1) + Tier Icons
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '0.65rem', fontSize: '0.7rem', fontWeight: 600 } },
                h('span', { style: { padding: '0.2rem 0.45rem', backgroundColor: '#e1ded6', border: '1px solid #0f3f49' } }, '✓ Healthy (>ROP)'),
                h('span', { style: { padding: '0.2rem 0.45rem', backgroundColor: 'rgb(203, 163, 159)', color: '#0f3f49' } }, '⚑ T1 Watch'),
                h('span', { style: { padding: '0.2rem 0.45rem', backgroundColor: 'rgb(165, 73, 75)', color: '#ece6df' } }, '▲ T2 Critical'),
                h('span', { style: { padding: '0.2rem 0.45rem', backgroundColor: '#7f0508', color: '#ece6df' } }, '🚨 T3 Emergency')
              )
            ),

            h('table', { className: 'heatmap-table' },
              h('thead', null,
                h('tr', null,
                  h('th', { style: { fontSize: '0.68rem', textAlign: 'left', padding: '0.3rem', color: '#0f3f49' } }, 'REGION \\ CATEGORY'),
                  liveNetwork.categories.map(cat => h('th', {
                    key: cat,
                    style: { fontSize: '0.66rem', fontWeight: 700, textAlign: 'center', padding: '0.25rem', color: '#0f3f49', maxWidth: '88px' }
                  }, cat))
                )
              ),
              h('tbody', null,
                liveNetwork.regions.map(reg => h('tr', { key: reg },
                  h('td', { style: { fontSize: '0.73rem', fontWeight: 700, padding: '0.35rem 0.4rem', whiteSpace: 'nowrap' } }, reg),
                  liveNetwork.categories.map(cat => {
                    const cell = liveNetwork.heatmapMatrix[reg][cat];
                    if (!cell) {
                      return h('td', {
                        key: cat,
                        style: { backgroundColor: 'rgba(15, 63, 73, 0.04)', textAlign: 'center', fontSize: '0.65rem', opacity: 0.4 }
                      }, '—');
                    }
                    const p = cell.primaryLane;
                    const style = getHeatmapStyle(p.severity, p.isHealthy);
                    const isSelected = selectedLane && selectedLane.id === p.id;
                    const tierIcon = p.tier === 3 ? '🚨 T3' : p.tier === 2 ? '▲ T2' : p.tier === 1 ? '⚑ T1' : '✓ OK';

                    return h('td', {
                      key: cat,
                      className: `heatmap-cell ${isSelected ? 'selected-cell' : ''}`,
                      style,
                      title: `${reg} · ${cat} (${p.product})\nTier: ${p.tierLabel} | Severity s=${p.severity}\nStock: ${p.stock}u | ROP: ${p.ROP}u | SS: ${p.SS}u\nDays of Cover: ${p.daysOfCover}d | Rev at Risk: $${p.revenueAtRisk.toLocaleString()}`,
                      onClick: () => setSelectedLaneId(p.id)
                    },
                      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.65rem', fontWeight: 800 } },
                        h('span', null, tierIcon),
                        h('span', null, `s=${p.severity.toFixed(2)}`)
                      ),
                      h('div', { style: { fontSize: '0.72rem', fontWeight: 700, marginTop: '0.15rem' } },
                        `${p.stock} / ${p.ROP}u`
                      ),
                      h('div', { style: { fontSize: '0.63rem', opacity: 0.9 } },
                        p.revenueAtRisk > 0 ? `$${(p.revenueAtRisk / 1000).toFixed(1)}k risk` : `${p.daysOfCover}d cov`
                      )
                    );
                  })
                ))
              )
            ),

            // Selected Cell Formula Inspector Strip
            selectedLane && h('div', {
              style: {
                marginTop: '0.9rem',
                padding: '0.85rem 1rem',
                backgroundColor: '#f5f1ec',
                border: '1px solid rgba(15, 63, 73, 0.25)',
                borderRadius: '3px',
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '0.75rem'
              }
            },
              h('div', null,
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '0.5rem' } },
                  h('span', { className: `tier-badge tier-badge-${selectedLane.tier}` }, selectedLane.tierLabel),
                  h('strong', { style: { fontSize: '0.92rem' } }, `${selectedLane.id}: ${selectedLane.region} · ${selectedLane.product}`),
                  h('span', { style: { fontSize: '0.75rem', opacity: 0.75 } }, `(${selectedLane.category})`)
                ),
                h('div', { style: { fontSize: '0.74rem', marginTop: '0.3rem' } },
                  `d = ${selectedLane.d}u/day | L = ${selectedLane.L}d | σ_d = ${selectedLane.sigma_d} | SS = ${selectedLane.SS}u | ROP = ${selectedLane.ROP}u | Stock = ${selectedLane.stock}u | Cover = ${selectedLane.daysOfCover}d | Severity s = ${selectedLane.severity}`
                )
              ),
              h('div', { style: { display: 'flex', gap: '0.5rem' } },
                h('button', {
                  className: 'btn-editorial',
                  onClick: () => setActiveTab('scenario_planner')
                }, 'Open in Scenario Planner →'),
                selectedLane.tier === 3 && h('button', {
                  className: 'btn-burgundy',
                  onClick: () => {
                    const payload = buildExecutionPayloads(selectedLane, rawData.staff_directory, rawData.sample_affected_orders);
                    setActivePoModal(payload.draftPO);
                  }
                }, 'Inspect Tier 3 Draft PO')
              )
            )
          ),

          // RIGHT COLUMN: LIVE ALERT FEED
          h('div', { className: 'concrete-card', style: { display: 'flex', flexDirection: 'column', gap: '0.75rem', maxHeight: '640px', overflowY: 'auto' } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #0f3f49', paddingBottom: '0.5rem' } },
              h('div', null,
                h('span', { style: { fontSize: '0.68rem', fontWeight: 800, letterSpacing: '0.06em' } },
                  `COOLDOWN: ${cooldownWindowSec}S DE-DUP`
                ),
                h('h2', { className: 'serif-title', style: { fontSize: '1.15rem' } },
                  `Live Alert Feed (${alertFeed.length})`
                )
              ),
              h('button', {
                className: 'btn-editorial',
                style: { padding: '0.25rem 0.55rem', fontSize: '0.68rem' },
                onClick: () => setActiveTab('execution_centre')
              }, 'Outbox →')
            ),

            alertFeed.length === 0
              ? h('div', { style: { padding: '1.5rem 0.5rem', textAlign: 'center', fontSize: '0.8rem', opacity: 0.75 } },
                  'Pull the Disruption Lever (+1d to +15d) or click a Stress Preset to trigger sequential Tier 1 → Tier 2 → Tier 3 escalations.'
                )
              : alertFeed.slice(0, 18).map(al => h('div', {
                  key: al.id,
                  style: {
                    padding: '0.65rem 0.75rem',
                    backgroundColor: '#f5f1ec',
                    borderLeft: `4px solid ${al.tier >= 2 ? '#7f0508' : '#0f3f49'}`,
                    borderRadius: '2px',
                    fontSize: '0.75rem'
                  }
                },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                    h('span', { className: `tier-badge tier-badge-${al.tier}` }, al.tierLabel),
                    h('span', { style: { fontSize: '0.68rem', opacity: 0.7 } }, al.timestamp)
                  ),
                  h('div', { style: { fontWeight: 700, marginTop: '0.25rem', cursor: 'pointer' }, onClick: () => setSelectedLaneId(al.laneId) },
                    `${al.region} · ${al.product}`
                  ),
                  h('div', { style: { fontSize: '0.7rem', marginTop: '0.15rem', opacity: 0.85 } },
                    `Stock: ${al.stock}u (ROP: ${al.rop}u, SS: ${al.ss}u) · Lead Time Alert: ${al.alertLeadTimeDays}d`
                  ),
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.35rem' } },
                    h('span', { style: { fontWeight: 700, color: '#7f0508', fontSize: '0.7rem' } },
                      `TCD: $${al.tcd.toLocaleString()}`
                    ),
                    al.acknowledged
                      ? h('span', { style: { fontSize: '0.66rem', fontWeight: 700, color: '#0f3f49' } }, `✓ Acked (${al.ackTimeSec}s)`)
                      : h('button', {
                          className: 'btn-editorial',
                          style: { padding: '0.15rem 0.45rem', fontSize: '0.66rem' },
                          onClick: () => handleAcknowledgeAlert(al.id)
                        }, 'Acknowledge')
                  )
                ))
          )
        )
      ),

      // =========================================================================
      // SCREEN 2: SCENARIO PLANNER
      // =========================================================================
      activeTab === 'scenario_planner' && selectedLane && h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1.25rem' } },
        // Top Lane Selector & Weighting Controls
        h('div', { className: 'concrete-card', style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' } },
          h('div', { style: { flex: '1 1 380px' } },
            h('span', { style: { fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.06em' } }, 'AGENT 03 · PRESCRIPTIVE SCENARIO PLANNER'),
            h('h2', { className: 'serif-title', style: { fontSize: '1.4rem', marginTop: '0.15rem' } },
              `${selectedLane.region} — ${selectedLane.product}`
            ),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.35rem', fontSize: '0.78rem' } },
              h('span', { className: `tier-badge tier-badge-${selectedLane.tier}` }, selectedLane.tierLabel),
              h('span', null, `Primary Hub: ${selectedLane.warehouse_hub}`),
              h('span', null, `Supplier: ${selectedLane.primary_supplier}`)
            )
          ),

          // Lane Selector Dropdown
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.3rem', minWidth: '280px' } },
            h('label', { style: { fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase' } }, 'Inspect SKU-Region Lane:'),
            h('select', {
              value: selectedLane.id,
              onChange: (e) => setSelectedLaneId(e.target.value),
              style: {
                padding: '0.5rem',
                fontFamily: 'var(--font-sans)',
                fontSize: '0.8rem',
                backgroundColor: '#f5f1ec',
                color: '#0f3f49',
                border: '1px solid #0f3f49',
                borderRadius: '2px'
              }
            },
              liveNetwork.lanes.map(l => h('option', { key: l.id, value: l.id },
                `[T${l.tier}] ${l.region} — ${l.product} (s=${l.severity.toFixed(2)})`
              ))
            )
          ),

          // Cost vs SLA Weighting Slider (default 60/40)
          h('div', { style: { minWidth: '260px', backgroundColor: '#f5f1ec', padding: '0.65rem 0.9rem', borderRadius: '3px', border: '1px solid rgba(15,63,73,0.2)' } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', fontWeight: 700, marginBottom: '0.3rem' } },
              h('span', null, `Cost Weight: ${weights.cost}%`),
              h('span', null, `SLA Weight: ${weights.sla}%`)
            ),
            h('input', {
              type: 'range',
              className: 'editorial-slider',
              min: 10,
              max: 90,
              step: 5,
              value: weights.cost,
              onChange: (e) => {
                const c = parseInt(e.target.value, 10);
                setWeights({ cost: c, sla: 100 - c });
              }
            }),
            h('div', { style: { fontSize: '0.68rem', opacity: 0.75, marginTop: '0.2rem' } },
              'Default 60/40 weighting dynamically re-ranks mitigation options.'
            )
          )
        ),

        // AI Recommendation Banner (Plain Two-Sentence Rationale)
        h('div', {
          className: 'concrete-card',
          style: {
            borderLeft: '6px solid #7f0508',
            backgroundColor: '#f5f1ec'
          }
        },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' } },
            h('div', null,
              h('span', { className: 'tier-badge tier-badge-3' }, 'RECOMMENDED SLA-SAFE MITIGATION'),
              h('h3', { className: 'serif-title', style: { fontSize: '1.3rem', marginTop: '0.35rem' } },
                selectedLane.recommendedOption.name
              )
            ),
            h('button', {
              className: 'btn-burgundy',
              onClick: () => {
                const payload = buildExecutionPayloads(selectedLane, rawData.staff_directory, rawData.sample_affected_orders);
                const po = payload.draftPO || {
                  poNumber: `PO-MIT-${selectedLane.id.split('-')[1]}-${Math.floor(1000 + Math.random() * 9000)}`,
                  laneId: selectedLane.id,
                  region: selectedLane.region,
                  product: selectedLane.product,
                  category: selectedLane.category,
                  vendor: selectedLane.recommendedOption.supplierUsed,
                  destinationHub: selectedLane.recommendedOption.hubUsed,
                  mitigationMode: selectedLane.recommendedOption.name,
                  quantity: selectedLane.orderQtyNeeded,
                  unitCost: Number((selectedLane.unit_price * 0.58).toFixed(2)),
                  landedCostDelta: selectedLane.recommendedOption.landedCostDelta,
                  totalPoValue: Math.round(selectedLane.orderQtyNeeded * selectedLane.unit_price * 0.58 + selectedLane.recommendedOption.landedCostDelta),
                  hodLimit: 25000,
                  requiresHodApproval: Math.round(selectedLane.orderQtyNeeded * selectedLane.unit_price * 0.58) > 25000,
                  approverRole: 'VP / HOD Supply Chain',
                  status: 'PENDING_APPROVAL',
                  createdAt: new Date().toLocaleTimeString(),
                  leadTimeDays: selectedLane.recommendedOption.effectiveLeadTime,
                  tcdProtected: selectedLane.tcdSavings
                };
                setDraftPOs(prev => [po, ...prev.filter(p => p.poNumber !== po.poNumber)]);
                setActivePoModal(po);
              }
            }, 'Generate & Review Expedited PO →')
          ),
          h('p', { style: { fontSize: '0.9rem', marginTop: '0.6rem', lineHeight: 1.55, fontWeight: 500 } },
            selectedLane.recommendationRationale
          )
        ),

        // Ranked Options Table + Side-by-Side Comparison Bar Chart
        h('div', { style: { display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: '1rem' } },
          h('div', { className: 'concrete-card' },
            h('h3', { className: 'serif-title', style: { fontSize: '1.15rem', marginBottom: '0.75rem' } },
              '4-Option Mitigation Ranking Matrix'
            ),
            h('table', { className: 'editorial-table' },
              h('thead', null,
                h('tr', null,
                  h('th', null, 'Rank & Strategy'),
                  h('th', null, 'Days Saved'),
                  h('th', null, 'Landed Cost Delta'),
                  h('th', null, 'SLA Score'),
                  h('th', null, 'Resulting TCD'),
                  h('th', null, `Weighted Score (${weights.cost}/${weights.sla})`)
                )
              ),
              h('tbody', null,
                selectedLane.options.map((opt, idx) => {
                  const isRec = idx === 0;
                  return h('tr', {
                    key: opt.id,
                    style: isRec ? { backgroundColor: 'rgba(127, 5, 8, 0.1)', fontWeight: 700 } : {}
                  },
                    h('td', null,
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: '0.4rem' } },
                        h('span', { className: isRec ? 'tier-badge tier-badge-3' : 'tier-badge tier-badge-0' }, `#${idx + 1}`),
                        h('span', null, opt.name)
                      )
                    ),
                    h('td', null, `${opt.daysSaved}d (L=${opt.effectiveLeadTime}d)`),
                    h('td', null, `$${opt.landedCostDelta.toLocaleString()}`),
                    h('td', null, `${opt.slaPreservationScore}%`),
                    h('td', { style: { color: opt.id === 'do_nothing' && !selectedLane.isHealthy ? '#7f0508' : '#0f3f49', fontWeight: 700 } },
                      `$${opt.totalCostOfDisruption.toLocaleString()}`
                    ),
                    h('td', { className: 'kpi-number', style: { fontSize: '1rem' } }, `${opt.compositeScore} pts`)
                  );
                })
              )
            )
          ),

          h('div', { className: 'concrete-card' },
            h('h3', { className: 'serif-title', style: { fontSize: '1.15rem', marginBottom: '0.5rem' } },
              'Total Cost of Disruption (TCD) by Option'
            ),
            h('p', { style: { fontSize: '0.74rem', opacity: 0.8, marginBottom: '0.6rem' } },
              'TCD = Residual Lost Margin + Residual SLA Penalty + Landed Cost Delta + Extra Holding Cost'
            ),
            h(EditorialBarChart, {
              items: selectedLane.options.map((opt, i) => ({
                label: `${i === 0 ? '★ ' : ''}${opt.shortName} (SLA: ${opt.slaPreservationScore}%)`,
                value: opt.totalCostOfDisruption,
                isHighlight: opt.id === 'do_nothing' && !selectedLane.isHealthy,
                color: i === 0 ? '#0f3f49' : (opt.id === 'do_nothing' ? '#7f0508' : '#4a6b72'),
                subLabel: `Landed Cost Delta: $${opt.landedCostDelta.toLocaleString()} | Residual Margin Loss: $${opt.residualLostMargin.toLocaleString()} | SLA Penalty: $${opt.residualSlaPenalty.toLocaleString()}`
              })),
              maxVal: Math.max(...selectedLane.options.map(o => o.totalCostOfDisruption), 1000)
            })
          )
        )
      ),

      // =========================================================================
      // SCREEN 3: EXECUTION CENTRE
      // =========================================================================
      activeTab === 'execution_centre' && h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1.25rem' } },

        // Top Execution Telemetry Row
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.9rem' } },
          h('div', { className: 'concrete-card' },
            h('div', { style: { fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase' } }, 'Mean Alert Lead Time'),
            h('div', { className: 'kpi-number', style: { fontSize: '1.65rem', marginTop: '0.2rem' } }, `${avgAlertLeadTime} Days`),
            h('div', { style: { fontSize: '0.72rem', opacity: 0.78, marginTop: '0.2rem' } }, 'Advance warning before physical stockout')
          ),
          h('div', { className: 'concrete-card' },
            h('div', { style: { fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase' } }, 'Mean Acknowledgement Time'),
            h('div', { className: 'kpi-number', style: { fontSize: '1.65rem', marginTop: '0.2rem' } }, `${avgAckTimeSec} Seconds`),
            h('div', { style: { fontSize: '0.72rem', opacity: 0.78, marginTop: '0.2rem' } }, 'Tracked from tier trigger to operator sign-off')
          ),
          h('div', { className: 'concrete-card' },
            h('div', { style: { fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase' } }, 'Operational False-Alarm Rate'),
            h('div', { className: 'kpi-number', style: { fontSize: '1.65rem', marginTop: '0.2rem' } }, `${falseAlarmRatePct}%`),
            h('div', { style: { fontSize: '0.72rem', opacity: 0.78, marginTop: '0.2rem' } }, `De-duplication cooldown: ${cooldownWindowSec}s window`)
          ),
          h('div', { className: 'concrete-card' },
            h('div', { style: { fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase' } }, 'Cooldown Window Config'),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: '0.35rem' } },
              h('input', {
                type: 'range',
                className: 'editorial-slider',
                min: 10,
                max: 120,
                step: 5,
                value: cooldownWindowSec,
                onChange: (e) => setCooldownWindowSec(parseInt(e.target.value, 10))
              }),
              h('span', { className: 'kpi-number', style: { fontSize: '1.2rem' } }, `${cooldownWindowSec}s`)
            ),
            h('div', { style: { fontSize: '0.68rem', opacity: 0.78, marginTop: '0.2rem' } }, 'Suppresses duplicate SKU-region tier alerts')
          )
        ),

        // 2x2 Grid: Outbox Emails, Draft POs, Second-Channel Slack/WhatsApp, Escalation Timers & Customer SLA Notices
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' } },

          // Panel 1: In-App Outbox (To, CC, Subject, Body Preview)
          h('div', { className: 'concrete-card', style: { maxHeight: '460px', overflowY: 'auto' } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #0f3f49', paddingBottom: '0.45rem', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' } },
              h('h3', { className: 'serif-title', style: { fontSize: '1.15rem' } },
                `1. Automated Outbox Emails (${outboxEmails.length})`
              ),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '0.45rem' } },
                h('button', {
                  className: 'btn-burgundy',
                  style: { padding: '0.22rem 0.55rem', fontSize: '0.7rem' },
                  onClick: () => dispatchRealEmail({
                    subject: `[Project Resilience Engine] Live Test Alert — ${selectedLane?.region || 'Global'} · ${selectedLane?.product || 'SKU'}`,
                    body: `LIVE CONTROL TOWER DISPATCH TO: abhinavjonnagadla1234@gmail.com\n\nSelected Lane: ${selectedLane?.id} (${selectedLane?.region} — ${selectedLane?.product})\nCurrent Tier: ${selectedLane?.tierLabel}\nOn-Hand Stock: ${selectedLane?.stock} units | ROP: ${selectedLane?.ROP} units | Safety Stock: ${selectedLane?.SS} units\nRevenue at Risk: $${(selectedLane?.revenueAtRisk || 0).toLocaleString()} | Unmitigated TCD: $${(selectedLane?.unmitigatedTCD || 0).toLocaleString()}\nRecommended Mitigation: ${selectedLane?.recommendedOption?.name}\n\n${selectedLane?.recommendationRationale}`,
                    tierLabel: selectedLane?.tierLabel || 'TEST',
                    region: selectedLane?.region || 'Global',
                    product: selectedLane?.product || 'SKU'
                  })
                }, '✉ Send Live Test Email to abhinavjonnagadla1234@gmail.com')
              )
            ),
            smtpStatus.lastResult && h('div', {
              style: {
                padding: '0.45rem 0.65rem',
                marginBottom: '0.65rem',
                backgroundColor: smtpStatus.lastResult.startsWith('✓') ? 'rgba(15, 63, 73, 0.12)' : 'rgba(127, 5, 8, 0.12)',
                color: smtpStatus.lastResult.startsWith('✓') ? '#0f3f49' : '#7f0508',
                fontSize: '0.73rem',
                fontWeight: 700,
                borderRadius: '2px'
              }
            }, smtpStatus.lastResult),
            outboxEmails.length === 0
              ? h('p', { style: { fontSize: '0.8rem', opacity: 0.75 } }, 'No emails dispatched yet. Pull the Disruption Lever on Screen 1 to trigger Tier 1/2/3 dispatches.')
              : outboxEmails.map(em => h('div', {
                  key: em.id,
                  style: {
                    backgroundColor: '#f5f1ec',
                    padding: '0.75rem',
                    borderRadius: '2px',
                    borderLeft: `4px solid ${em.tier >= 2 ? '#7f0508' : '#0f3f49'}`,
                    marginBottom: '0.65rem',
                    fontSize: '0.75rem'
                  }
                },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                    h('span', { className: `tier-badge tier-badge-${em.tier}` }, em.tierLabel),
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: '0.45rem' } },
                      h('button', {
                        className: 'btn-editorial',
                        style: { padding: '0.12rem 0.45rem', fontSize: '0.66rem' },
                        onClick: () => dispatchRealEmail(em)
                      }, '✉ Forward to My Gmail'),
                      h('span', { style: { opacity: 0.7 } }, em.timestamp)
                    )
                  ),
                  h('div', { style: { marginTop: '0.3rem' } }, h('strong', null, 'To: '), `${em.to}, abhinavjonnagadla1234@gmail.com`),
                  h('div', null, h('strong', null, 'CC: '), em.cc),
                  h('div', { style: { fontWeight: 700, marginTop: '0.2rem' } }, em.subject),
                  h('pre', {
                    style: {
                      marginTop: '0.4rem',
                      padding: '0.5rem',
                      backgroundColor: '#ece6df',
                      fontSize: '0.68rem',
                      whiteSpace: 'pre-wrap',
                      fontFamily: 'monospace',
                      maxHeight: '130px',
                      overflowY: 'auto'
                    }
                  }, em.body)
                ))
          ),

          // Panel 2: Tier 3 Expedited Draft POs (with HOD Approval Gate & Modal Trigger)
          h('div', { className: 'concrete-card', style: { maxHeight: '440px', overflowY: 'auto' } },
            h('h3', { className: 'serif-title', style: { fontSize: '1.15rem', borderBottom: '2px solid #0f3f49', paddingBottom: '0.45rem', marginBottom: '0.75rem' } },
              `2. Tier 3 Expedited Draft POs (${draftPOs.length})`
            ),
            draftPOs.length === 0
              ? h('p', { style: { fontSize: '0.8rem', opacity: 0.75 } }, 'Pull the Disruption Lever to +10 days to trigger Tier 3 Emergency auto-drafted POs.')
              : draftPOs.map(po => h('div', {
                  key: po.poNumber,
                  style: {
                    backgroundColor: '#f5f1ec',
                    padding: '0.75rem',
                    borderRadius: '2px',
                    border: '1px solid rgba(15,63,73,0.25)',
                    marginBottom: '0.65rem',
                    fontSize: '0.76rem'
                  }
                },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                    h('strong', { style: { fontSize: '0.88rem' } }, `${po.poNumber} · ${po.region}`),
                    h('span', {
                      className: po.status === 'APPROVED' ? 'tier-badge tier-badge-0' : po.status === 'REJECTED' ? 'tier-badge tier-badge-3' : 'tier-badge tier-badge-2'
                    }, po.status)
                  ),
                  h('div', { style: { marginTop: '0.25rem', fontWeight: 600 } }, `${po.product} — Qty: ${po.quantity}u`),
                  h('div', { style: { fontSize: '0.72rem', opacity: 0.85 } },
                    `Vendor: ${po.vendor} · Mode: ${po.mitigationMode}`
                  ),
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.4rem' } },
                    h('span', { className: 'kpi-number', style: { fontSize: '1rem', color: '#7f0508' } },
                      `Total Value: $${po.totalPoValue.toLocaleString()} ${po.requiresHodApproval ? '(HOD Sign-Off Req > $25k)' : ''}`
                    ),
                    h('div', { style: { display: 'flex', gap: '0.35rem' } },
                      h('button', {
                        className: 'btn-editorial',
                        style: { padding: '0.22rem 0.5rem', fontSize: '0.7rem' },
                        onClick: () => setActivePoModal(po)
                      }, 'Open PO Modal'),
                      po.status === 'PENDING_APPROVAL' && h('button', {
                        className: 'btn-burgundy',
                        style: { padding: '0.22rem 0.5rem', fontSize: '0.7rem' },
                        onClick: () => handlePoDecision(po.poNumber, 'APPROVED')
                      }, 'Approve')
                    )
                  )
                ))
          ),

          // Panel 3: Second-Channel War-Room Messages (Slack / WhatsApp Enterprise) & Escalation Countdown Timers
          h('div', { className: 'concrete-card', style: { maxHeight: '440px', overflowY: 'auto' } },
            h('h3', { className: 'serif-title', style: { fontSize: '1.15rem', borderBottom: '2px solid #0f3f49', paddingBottom: '0.45rem', marginBottom: '0.75rem' } },
              `3. Second-Channel War-Room & Escalation Timers`
            ),
            // Active Escalation Timers
            Object.values(escalationTimers).length > 0 && h('div', { style: { marginBottom: '0.75rem' } },
              h('div', { style: { fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', marginBottom: '0.35rem', color: '#7f0508' } },
                'LIVE TIER 3 ESCALATION COUNTDOWN TIMERS'
              ),
              Object.values(escalationTimers).slice(0, 6).map(tm => h('div', {
                key: tm.alertId,
                style: {
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  backgroundColor: tm.escalated ? '#7f0508' : '#ece6df',
                  color: tm.escalated ? '#ece6df' : '#0f3f49',
                  padding: '0.45rem 0.65rem',
                  borderRadius: '2px',
                  marginBottom: '0.35rem',
                  fontSize: '0.73rem',
                  fontWeight: 600
                }
              },
                h('span', null, `${tm.region} · ${tm.product}`),
                tm.acknowledged
                  ? h('span', null, '✓ Acknowledged (Timer Halted)')
                  : tm.escalated
                    ? h('span', null, `⚠ ${tm.level}`)
                    : h('div', { style: { display: 'flex', alignItems: 'center', gap: '0.45rem' } },
                        h('span', { style: { color: '#7f0508', fontWeight: 800 } }, `⏱ ${tm.remainingSec}s to COO Escalation`),
                        h('button', {
                          className: 'btn-editorial',
                          style: { padding: '0.12rem 0.4rem', fontSize: '0.65rem' },
                          onClick: () => handleAcknowledgeAlert(tm.alertId)
                        }, 'Ack')
                      )
              ))
            ),
            // Slack / WhatsApp Messages
            secondChannelMessages.length === 0
              ? h('p', { style: { fontSize: '0.8rem', opacity: 0.75 } }, 'No Tier 3 Slack/WhatsApp dispatches yet.')
              : secondChannelMessages.map(msg => h('div', {
                  key: msg.id,
                  style: {
                    backgroundColor: '#0a2b32',
                    color: '#ece6df',
                    padding: '0.7rem',
                    borderRadius: '3px',
                    marginBottom: '0.55rem',
                    fontSize: '0.74rem'
                  }
                },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '0.66rem', opacity: 0.8 } },
                    h('span', null, msg.channel),
                    h('span', null, msg.timestamp)
                  ),
                  h('div', { style: { fontSize: '0.68rem', color: '#dcd4ca', marginTop: '0.15rem' } }, `Tagged: ${msg.handles}`),
                  h('pre', { style: { whiteSpace: 'pre-wrap', fontFamily: 'var(--font-sans)', marginTop: '0.35rem', lineHeight: 1.4 } }, msg.text)
                ))
          ),

          // Panel 4: Customer SLA Warning Notices & Audit Log
          h('div', { className: 'concrete-card', style: { maxHeight: '440px', overflowY: 'auto' } },
            h('h3', { className: 'serif-title', style: { fontSize: '1.15rem', borderBottom: '2px solid #0f3f49', paddingBottom: '0.45rem', marginBottom: '0.75rem' } },
              `4. Affected Customer SLA Notices (${customerNotices.length})`
            ),
            customerNotices.length === 0
              ? h('p', { style: { fontSize: '0.8rem', opacity: 0.75 } }, 'Customer SLA advisories are auto-drafted upon Tier 3 Emergency events.')
              : customerNotices.map((nt, i) => h('div', {
                  key: `${nt.noticeId}-${i}`,
                  style: {
                    backgroundColor: '#f5f1ec',
                    padding: '0.7rem',
                    borderRadius: '2px',
                    borderLeft: '3px solid #0f3f49',
                    marginBottom: '0.55rem',
                    fontSize: '0.74rem'
                  }
                },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', fontWeight: 700 } },
                    h('span', null, `${nt.orderId} · ${nt.customerLocation}`),
                    h('span', { className: 'tier-badge tier-badge-0' }, `Value: $${nt.orderValue.toLocaleString()}`)
                  ),
                  h('p', { style: { marginTop: '0.3rem', lineHeight: 1.4 } }, nt.message)
                ))
          )
        )
      ),

      // =========================================================================
      // SCREEN 4: IMPACT & SENSITIVITY ANALYSIS
      // =========================================================================
      activeTab === 'impact_roi' && h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1.25rem' } },
        h('div', { className: 'concrete-card' },
          h('span', { style: { fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.06em' } }, 'EXECUTIVE BUSINESS CASE & ROI'),
          h('h2', { className: 'serif-title', style: { fontSize: '1.45rem', marginTop: '0.15rem' } },
            'Before vs. After Autonomous Agent Intervention'
          ),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '1rem', marginTop: '1rem' } },
            h('div', { className: 'concrete-card-light' },
              h('div', { style: { fontSize: '0.72rem', fontWeight: 700 } }, 'UNMITIGATED TCD (DO NOTHING)'),
              h('div', { className: 'kpi-number', style: { fontSize: '1.8rem', color: '#7f0508', marginTop: '0.2rem' } },
                `$${kpis.totalUnmitigatedTCD.toLocaleString()}`
              ),
              h('div', { style: { fontSize: '0.72rem', marginTop: '0.25rem' } }, 'Full exposure to margin loss & SLA penalties')
            ),
            h('div', { className: 'concrete-card-light' },
              h('div', { style: { fontSize: '0.72rem', fontWeight: 700 } }, 'MITIGATED TCD (WITH AI AGENTS)'),
              h('div', { className: 'kpi-number', style: { fontSize: '1.8rem', color: '#0f3f49', marginTop: '0.2rem' } },
                `$${kpis.totalMitigatedTCD.toLocaleString()}`
              ),
              h('div', { style: { fontSize: '0.72rem', marginTop: '0.25rem' } }, `Includes $${kpis.totalLandedCostDelta.toLocaleString()} Landed Cost Delta`)
            ),
            h('div', { className: 'concrete-card-light' },
              h('div', { style: { fontSize: '0.72rem', fontWeight: 700 } }, 'NET PROFIT PROTECTED (SAVINGS)'),
              h('div', { className: 'kpi-number', style: { fontSize: '1.8rem', color: '#0f3f49', marginTop: '0.2rem' } },
                `$${kpis.tcdSavedByAgents.toLocaleString()}`
              ),
              h('div', { style: { fontSize: '0.72rem', marginTop: '0.25rem' } },
                `Revenue Protected: $${kpis.totalProtectedRevenue.toLocaleString()}`
              )
            ),
            h('div', { className: 'concrete-card-light' },
              h('div', { style: { fontSize: '0.72rem', fontWeight: 700 } }, 'SYSTEM ROI MULTIPLE'),
              h('div', { className: 'kpi-number', style: { fontSize: '1.8rem', color: '#0f3f49', marginTop: '0.2rem' } },
                `${(kpis.tcdSavedByAgents / Math.max(1, kpis.totalLandedCostDelta || 45000)).toFixed(1)}x`
              ),
              h('div', { style: { fontSize: '0.72rem', marginTop: '0.25rem' } },
                `SLA Uplift: ${kpis.slaComplianceRate}% → ${kpis.mitigatedSlaComplianceRate}%`
              )
            )
          )
        ),

        // Side-by-Side Before/After Chart + Tornado Sensitivity Analysis (±20% Lead Time, ±20% Demand, ±20% Freight)
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' } },
          h('div', { className: 'concrete-card' },
            h('h3', { className: 'serif-title', style: { fontSize: '1.2rem', marginBottom: '0.6rem' } },
              'Before vs. After Intervention Breakdown'
            ),
            h(EditorialBarChart, {
              items: [
                {
                  label: 'Unmitigated TCD (Passive Monitoring Only)',
                  value: kpis.totalUnmitigatedTCD,
                  color: '#7f0508',
                  subLabel: `Lost Margin: $${kpis.totalLostMargin.toLocaleString()} + SLA Penalties: $${kpis.totalSlaPenalty.toLocaleString()}`
                },
                {
                  label: 'Mitigated TCD (Autonomous Resilience Engine)',
                  value: kpis.totalMitigatedTCD,
                  color: '#0f3f49',
                  subLabel: `Optimal Mix of Re-Routing, Alt Suppliers & Air Charter`
                },
                {
                  label: 'Total Revenue Protected Across Active Lanes',
                  value: kpis.totalProtectedRevenue,
                  color: '#16525e',
                  subLabel: `Preserves ${kpis.mitigatedSlaComplianceRate}% Network SLA Compliance`
                }
              ],
              maxVal: Math.max(kpis.totalUnmitigatedTCD, kpis.totalProtectedRevenue, 10000)
            })
          ),

          // Tornado Sensitivity Analysis (±20% Lead Time, ±20% Demand, ±20% Freight)
          h('div', { className: 'concrete-card' },
            h('h3', { className: 'serif-title', style: { fontSize: '1.2rem', marginBottom: '0.35rem' } },
              'Tornado Sensitivity Analysis (±20% Parameter Shock)'
            ),
            h('p', { style: { fontSize: '0.75rem', opacity: 0.8, marginBottom: '0.85rem' } },
              'Quantifies Total Cost of Disruption (TCD) sensitivity to ±20% swings around current operational state.'
            ),
            (() => {
              const baseTcd = kpis.totalUnmitigatedTCD;
              const ltPlus20 = evaluateNetwork(rawData, { ...levers, disruptionDays: levers.disruptionDays + 2.4 }, stockOverrides, weights).kpis.totalUnmitigatedTCD;
              const ltMinus20 = evaluateNetwork(rawData, { ...levers, disruptionDays: Math.max(0, levers.disruptionDays - 2.4) }, stockOverrides, weights).kpis.totalUnmitigatedTCD;

              const demPlus20 = evaluateNetwork(rawData, { ...levers, demandSurgePct: levers.demandSurgePct + 20 }, stockOverrides, weights).kpis.totalUnmitigatedTCD;
              const demMinus20 = evaluateNetwork(rawData, { ...levers, demandSurgePct: levers.demandSurgePct - 20 }, stockOverrides, weights).kpis.totalUnmitigatedTCD;

              const frPlus20 = evaluateNetwork(rawData, { ...levers, freightMultiplier: levers.freightMultiplier * 1.2 }, stockOverrides, weights).kpis.totalMitigatedTCD;
              const frMinus20 = evaluateNetwork(rawData, { ...levers, freightMultiplier: levers.freightMultiplier * 0.8 }, stockOverrides, weights).kpis.totalMitigatedTCD;

              const tornadoRows = [
                {
                  factor: 'Lead Time (L) ±20%',
                  low: ltMinus20 - baseTcd,
                  high: ltPlus20 - baseTcd,
                  swing: Math.abs(ltPlus20 - ltMinus20)
                },
                {
                  factor: 'Daily Demand (d) ±20%',
                  low: demMinus20 - baseTcd,
                  high: demPlus20 - baseTcd,
                  swing: Math.abs(demPlus20 - demMinus20)
                },
                {
                  factor: 'Freight Rates ±20%',
                  low: frMinus20 - kpis.totalMitigatedTCD,
                  high: frPlus20 - kpis.totalMitigatedTCD,
                  swing: Math.abs(frPlus20 - frMinus20)
                }
              ].sort((a, b) => b.swing - a.swing);

              const maxSwing = Math.max(...tornadoRows.map(r => Math.max(Math.abs(r.low), Math.abs(r.high))), 1000);

              return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1rem' } },
                tornadoRows.map(row => {
                  const lowPct = clamp((Math.abs(row.low) / maxSwing) * 48, 2, 48);
                  const highPct = clamp((Math.abs(row.high) / maxSwing) * 48, 2, 48);
                  return h('div', { key: row.factor },
                    h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', fontWeight: 700, marginBottom: '0.25rem' } },
                      h('span', null, row.factor),
                      h('span', null, `Total Swing: $${Math.round(row.swing).toLocaleString()}`)
                    ),
                    h('div', {
                      style: {
                        position: 'relative',
                        height: '24px',
                        backgroundColor: 'rgba(15,63,73,0.08)',
                        borderRadius: '2px',
                        display: 'flex',
                        alignItems: 'center'
                      }
                    },
                      // Center axis
                      h('div', { style: { position: 'absolute', left: '50%', top: 0, bottom: 0, width: '2px', backgroundColor: '#0f3f49', zIndex: 2 } }),
                      // Left bar (-20% favorable)
                      h('div', {
                        style: {
                          position: 'absolute',
                          right: '50%',
                          width: `${lowPct}%`,
                          height: '16px',
                          backgroundColor: '#0f3f49',
                          borderRadius: '2px 0 0 2px'
                        }
                      }),
                      // Right bar (+20% adverse shock)
                      h('div', {
                        style: {
                          position: 'absolute',
                          left: '50%',
                          width: `${highPct}%`,
                          height: '16px',
                          backgroundColor: '#7f0508',
                          borderRadius: '0 2px 2px 0'
                        }
                      })
                    ),
                    h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '0.68rem', marginTop: '0.2rem', opacity: 0.85 } },
                      h('span', { style: { color: '#0f3f49', fontWeight: 700 } }, `-20% Shock: ${row.low <= 0 ? '-' : '+'}$${Math.abs(Math.round(row.low)).toLocaleString()}`),
                      h('span', { style: { color: '#7f0508', fontWeight: 700 } }, `+20% Shock: +$${Math.abs(Math.round(row.high)).toLocaleString()}`)
                    )
                  );
                })
              );
            })()
          )
        )
      ),

      // =========================================================================
      // SCREEN 5: ASSUMPTIONS, DATA LINEAGE & MODEL TRANSPARENCY
      // =========================================================================
      activeTab === 'assumptions' && h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1.25rem' } },
        h('div', { className: 'concrete-card' },
          h('span', { style: { fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.06em' } }, 'OPEN METHODOLOGY & AUDITABILITY'),
          h('h2', { className: 'serif-title', style: { fontSize: '1.45rem', marginTop: '0.15rem' } },
            'Data Lineage, Synthetic Layer Specifications & ML Risk Model'
          ),
          h('p', { style: { fontSize: '0.84rem', marginTop: '0.4rem', opacity: 0.9 } },
            'Every number in Project Resilience Engine traces directly to empirical DataCo Global records or an explicitly documented, seeded synthetic inventory layer (seed = 42).'
          ),

          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.2rem', marginTop: '1rem' } },
            // Empirical DataCo Lineage
            h('div', { className: 'concrete-card-light' },
              h('h3', { className: 'serif-title', style: { fontSize: '1.1rem', marginBottom: '0.5rem' } },
                '1. Empirical Layer (DataCo Smart Supply Chain CSV)'
              ),
              h('ul', { style: { paddingLeft: '1.1rem', fontSize: '0.78rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' } },
                h('li', null, h('strong', null, 'Source File: '), `${rawData.metadata.source_dataset} (${rawData.model_metrics.date_range})`),
                h('li', null, h('strong', null, 'Real Columns Used: '), 'order date (DateOrders), shipping date (DateOrders), Days for shipping (real), Days for shipment (scheduled), Late_delivery_risk, Order Region, Market, Shipping Mode, Product Name, Category Name, Order Item Quantity, Order Item Product Price, Sales, Order Profit Per Order.'),
                h('li', null, h('strong', null, 'Engineered Feature: '), 'delay_delta = Days for shipping (real) − Days for shipment (scheduled).'),
                h('li', null, h('strong', null, 'Aggregation Strategy: '), 'Aggregated 180,519 raw rows into 136 high-volume Product × Region SKU lanes across 10 global regions and 10 categories (169.8 KB JSON) for sub-5ms browser interactivity.')
              )
            ),

            // Synthetic Layer
            h('div', { className: 'concrete-card-light' },
              h('h3', { className: 'serif-title', style: { fontSize: '1.1rem', marginBottom: '0.5rem' } },
                '2. Seeded Synthetic Layer (Seed = 42)'
              ),
              h('ul', { style: { paddingLeft: '1.1rem', fontSize: '0.78rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' } },
                h('li', null, h('strong', null, 'Stock on Hand: '), 'Seeded relative to baseline ROP (76% Healthy above ROP, 15% near Watch, 7% near Critical, 2% Emergency) so pulling the Disruption Lever smoothly cascades lanes through Tiers 1 → 2 → 3.'),
                h('li', null, h('strong', null, 'Warehouses & Suppliers: '), '10 regional primary fulfillment hubs, 10 backup hubs, and 20 primary/alternate suppliers with baseline reliability (86%–96%).'),
                h('li', null, h('strong', null, 'Freight & Expedite Rates: '), 'Standard ($4.20/u), Second Class ($6.80/u), First Class ($11.50/u), Air Expedite ($19.80/u + $9.20 expedite premium + $2.60 handling).'),
                h('li', null, h('strong', null, 'SLA Penalty & Approval Gate: '), 'Regional SLA penalty rate (7.0%–9.5% of late order value). HOD PO sign-off required above $25,000.'),
                h('li', null, h('strong', null, 'Staff Directory: '), '30 fictional regional contacts (Supervisor, Manager, HOD per region) with emails and Slack handles.')
              )
            )
          )
        ),

        // Core Formulas & ML Model Validation
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' } },
          h('div', { className: 'concrete-card' },
            h('h3', { className: 'serif-title', style: { fontSize: '1.15rem', marginBottom: '0.5rem' } },
              '3. Exact Mathematical Formulas (Client-Side Engine)'
            ),
            h('table', { className: 'editorial-table' },
              h('thead', null,
                h('tr', null, h('th', null, 'Metric'), h('th', null, 'Exact Formula Implemented'))
              ),
              h('tbody', null,
                [
                  ['Safety Stock (SS)', 'SS = z · σ_d · √L  (default z = 1.65)'],
                  ['Reorder Point (ROP)', 'ROP = d · L + SS'],
                  ['Days of Cover', 'Days of Cover = stock / d'],
                  ['Severity Score (s)', 's = clamp(1 − stock / ROP, 0, 1)'],
                  ['Revenue at Risk', 'max(0, d · L − stock) × unit_price'],
                  ['SLA Penalty', 'penalty_rate × value_of_orders_expected_late'],
                  ['Landed Cost Delta', '(freight + expedite_premium + handling) − baseline'],
                  ['Total Cost of Disruption', 'lost_margin + sla_penalties + mitigation_cost + extra_holding_cost']
                ].map(([m, f]) => h('tr', { key: m },
                  h('td', { style: { fontWeight: 700 } }, m),
                  h('td', { style: { fontFamily: 'monospace', fontSize: '0.76rem' } }, f)
                ))
              )
            )
          ),

          h('div', { className: 'concrete-card' },
            h('h3', { className: 'serif-title', style: { fontSize: '1.15rem', marginBottom: '0.5rem' } },
              '4. Late Delivery Risk Model Performance & Limitations'
            ),
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.6rem', marginBottom: '0.75rem' } },
              h('div', { className: 'concrete-card-light', style: { textAlign: 'center' } },
                h('div', { style: { fontSize: '0.68rem', fontWeight: 700 } }, 'GB ACCURACY'),
                h('div', { className: 'kpi-number', style: { fontSize: '1.4rem' } }, `${(rawData.model_metrics.gb_accuracy * 100).toFixed(2)}%`)
              ),
              h('div', { className: 'concrete-card-light', style: { textAlign: 'center' } },
                h('div', { style: { fontSize: '0.68rem', fontWeight: 700 } }, 'LOGISTIC REG'),
                h('div', { className: 'kpi-number', style: { fontSize: '1.4rem' } }, `${(rawData.model_metrics.lr_accuracy * 100).toFixed(2)}%`)
              ),
              h('div', { className: 'concrete-card-light', style: { textAlign: 'center' } },
                h('div', { style: { fontSize: '0.68rem', fontWeight: 700 } }, 'ROC-AUC SCORE'),
                h('div', { className: 'kpi-number', style: { fontSize: '1.4rem' } }, rawData.model_metrics.roc_auc)
              )
            ),
            h('p', { style: { fontSize: '0.78rem', lineHeight: 1.5 } },
              'Features: Order Region, Shipping Mode, Days for shipment (scheduled), and Category Name. Trained on 36,000 stratified transactions and validated on 9,000 holdout transactions (Precision: 84.1%). Limitations: Historical DataCo records do not capture external weather/port telemetry or multi-echelon BOM dependencies; hence transit shocks are injected via the interactive Disruption Lever.'
            )
          )
        )
      )
    ),

    // TIER 3 DRAFT PO APPROVAL MODAL
    activePoModal && h('div', {
      style: {
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(10, 43, 50, 0.82)',
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem'
      }
    },
      h('div', {
        className: 'concrete-card',
        style: {
          maxWidth: '580px',
          width: '100%',
          border: '3px solid #7f0508',
          boxShadow: '0 16px 40px rgba(0,0,0,0.5)'
        }
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #0f3f49', paddingBottom: '0.5rem' } },
          h('span', { className: 'tier-badge tier-badge-3' }, 'TIER 3 · AUTO-DRAFTED EXPEDITED PURCHASE ORDER'),
          h('button', {
            className: 'btn-editorial',
            style: { padding: '0.2rem 0.5rem' },
            onClick: () => setActivePoModal(null)
          }, '✕ Close')
        ),
        h('h3', { className: 'serif-title', style: { fontSize: '1.35rem', marginTop: '0.6rem' } },
          `${activePoModal.poNumber} — ${activePoModal.product}`
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', marginTop: '0.75rem', fontSize: '0.8rem', backgroundColor: '#f5f1ec', padding: '0.85rem', borderRadius: '2px' } },
          h('div', null, h('strong', null, 'Region / Hub: '), `${activePoModal.region} (${activePoModal.destinationHub})`),
          h('div', null, h('strong', null, 'Vendor: '), activePoModal.vendor),
          h('div', null, h('strong', null, 'Mitigation Mode: '), activePoModal.mitigationMode),
          h('div', null, h('strong', null, 'Expedited Lead Time: '), `${activePoModal.leadTimeDays} Days`),
          h('div', null, h('strong', null, 'Order Quantity: '), `${activePoModal.quantity.toLocaleString()} units`),
          h('div', null, h('strong', null, 'Landed Cost Delta: '), `$${activePoModal.landedCostDelta.toLocaleString()}`),
          h('div', null, h('strong', null, 'Total PO Value: '), h('span', { style: { color: '#7f0508', fontWeight: 800 } }, `$${activePoModal.totalPoValue.toLocaleString()}`)),
          h('div', null, h('strong', null, 'TCD Protected: '), `$${(activePoModal.tcdProtected || 0).toLocaleString()}`)
        ),
        activePoModal.requiresHodApproval && h('div', {
          style: {
            marginTop: '0.75rem',
            padding: '0.55rem 0.75rem',
            backgroundColor: 'rgba(127, 5, 8, 0.14)',
            borderLeft: '4px solid #7f0508',
            fontSize: '0.76rem',
            fontWeight: 700,
            color: '#7f0508'
          }
        }, `GOVERNANCE GATE: PO value exceeds $${activePoModal.hodLimit.toLocaleString()} limit. Requires ${activePoModal.approverRole} authorization.`),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '0.65rem', marginTop: '1rem' } },
          h('button', {
            className: 'btn-editorial',
            onClick: () => handlePoDecision(activePoModal.poNumber, 'REJECTED')
          }, 'Reject Draft PO'),
          h('button', {
            className: 'btn-burgundy',
            onClick: () => handlePoDecision(activePoModal.poNumber, 'APPROVED')
          }, activePoModal.requiresHodApproval ? 'Approve as HOD & Dispatch PO' : 'Approve & Dispatch PO')
        )
      )
    )
  );
}
