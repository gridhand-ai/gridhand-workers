/**
 * GRIDHAND Parts Prophet — Supabase Database Layer
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Connections ──────────────────────────────────────────────────────────────

async function getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('parts_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllConnectedClients() {
    const { data, error } = await supabase
        .from('parts_connections')
        .select('client_slug');
    if (error) throw error;
    return data || [];
}

async function upsertConnection(conn) {
    const { error } = await supabase
        .from('parts_connections')
        .upsert({ ...conn, updated_at: new Date().toISOString() }, { onConflict: 'client_slug' });
    if (error) throw error;
}

// ─── Schedule Scans ───────────────────────────────────────────────────────────

async function upsertScheduleScan(clientSlug, scan) {
    const { error } = await supabase
        .from('schedule_scans')
        .upsert({
            client_slug:        clientSlug,
            scan_date:          scan.scanDate,
            target_date:        scan.targetDate,
            appointments_found: scan.appointmentsFound,
            parts_identified:   scan.partsIdentified,
            total_savings_est:  scan.totalSavingsEst || null,
        }, { onConflict: 'client_slug,scan_date,target_date' });
    if (error) throw error;
}

// ─── Parts Needed ─────────────────────────────────────────────────────────────

async function upsertPartNeeded(clientSlug, part) {
    const { error } = await supabase
        .from('parts_needed')
        .upsert({
            client_slug:         clientSlug,
            tekmetric_job_id:    part.tekmetricJobId,
            tekmetric_ro_number: part.roNumber || null,
            appointment_date:    part.appointmentDate,
            vehicle_year:        part.vehicleYear || null,
            vehicle_make:        part.vehicleMake || null,
            vehicle_model:       part.vehicleModel || null,
            vehicle_engine:      part.vehicleEngine || null,
            part_number:         part.partNumber,
            part_description:    part.partDescription,
            quantity_needed:     part.quantityNeeded || 1,
            status:              part.status || 'pending',
            updated_at:          new Date().toISOString(),
        }, { onConflict: 'client_slug,tekmetric_job_id,part_number' });
    if (error) throw error;
}

async function getPendingParts(clientSlug, appointmentDate) {
    const { data, error } = await supabase
        .from('parts_needed')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'pending')
        .eq('appointment_date', appointmentDate);
    if (error) throw error;
    return data || [];
}

async function updatePartStatus(clientSlug, id, { status, chosenSupplier, chosenPrice, orderId }) {
    const { error } = await supabase
        .from('parts_needed')
        .update({
            status:          status,
            chosen_supplier: chosenSupplier || null,
            chosen_price:    chosenPrice || null,
            order_id:        orderId || null,
            updated_at:      new Date().toISOString(),
        })
        .eq('client_slug', clientSlug)
        .eq('id', id);
    if (error) throw error;
}

// ─── Price Comparisons ────────────────────────────────────────────────────────

async function saveComparison(clientSlug, comparison) {
    const { error } = await supabase
        .from('price_comparisons')
        .insert({
            client_slug:        clientSlug,
            part_number:        comparison.partNumber,
            part_description:   comparison.partDescription || null,
            vehicle_year:       comparison.vehicleYear || null,
            vehicle_make:       comparison.vehicleMake || null,
            vehicle_model:      comparison.vehicleModel || null,
            worldpac_price:     comparison.worldpacPrice || null,
            worldpac_available: comparison.worldpacAvailable ?? null,
            worldpac_eta:       comparison.worldpacEta || null,
            autozone_price:     comparison.autozonePrice || null,
            autozone_available: comparison.autozoneAvailable ?? null,
            autozone_eta:       comparison.autozoneEta || null,
            best_supplier:      comparison.bestSupplier,
            savings_vs_worst:   comparison.savingsVsWorst || null,
        });
    if (error) throw error;
}

// ─── Parts Orders ─────────────────────────────────────────────────────────────

async function saveOrder(clientSlug, order) {
    const { data, error } = await supabase
        .from('parts_orders')
        .insert({
            client_slug:  clientSlug,
            supplier:     order.supplier,
            order_id:     order.orderId || null,
            order_date:   order.orderDate,
            delivery_date: order.deliveryDate || null,
            total_parts:  order.totalParts,
            total_cost:   order.totalCost || null,
            status:       'placed',
            line_items:   order.lineItems ? JSON.stringify(order.lineItems) : null,
        })
        .select()
        .single();
    if (error) throw error;
    return data;
}

async function getRecentOrders(clientSlug, limit = 30) {
    const { data, error } = await supabase
        .from('parts_orders')
        .select('*')
        .eq('client_slug', clientSlug)
        .order('order_date', { ascending: false })
        .limit(limit);
    if (error) throw error;
    return data || [];
}

// ─── Alert Log ────────────────────────────────────────────────────────────────

async function logAlert(clientSlug, { alertType, recipient, messageBody }) {
    const { error } = await supabase
        .from('parts_alerts')
        .insert({
            client_slug:  clientSlug,
            alert_type:   alertType,
            recipient,
            message_body: messageBody,
        });
    if (error) throw error;
}

async function getAlertHistory(clientSlug, alertType = null, limit = 50) {
    let query = supabase
        .from('parts_alerts')
        .select('*')
        .eq('client_slug', clientSlug)
        .order('sent_at', { ascending: false })
        .limit(limit);
    if (alertType) query = query.eq('alert_type', alertType);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

module.exports = {
    getConnection,
    getAllConnectedClients,
    upsertConnection,
    upsertScheduleScan,
    upsertPartNeeded,
    getPendingParts,
    updatePartStatus,
    saveComparison,
    saveOrder,
    getRecentOrders,
    logAlert,
    getAlertHistory,
};
