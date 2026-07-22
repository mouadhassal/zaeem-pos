import { useEffect, useState, useCallback } from "react";
import { useCurrency } from "../../hooks/useCurrency";
import * as deliveryService from "../../lib/deliveryService";
import type { DriverStatus } from "../../db/types";
import {
  Truck, Users, MapPin, History, Plus, X, Phone, Car,
  Navigation, Star,
} from "lucide-react";

type Tab = "active" | "drivers" | "zones" | "history";

interface ActiveDeliveryRow {
  log_id: string;
  delivery_status: string;
  assigned_at: string;
  picked_up_at: string | null;
  order_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_address: string | null;
  total_cents: number;
  driver_id: string;
  driver_name: string;
  driver_phone: string;
  vehicle_type: string;
  vehicle_plate: string | null;
}

interface DriverRow {
  id: string;
  name: string;
  phone: string;
  photo_path: string | null;
  vehicle_type: string;
  vehicle_plate: string | null;
  status: DriverStatus;
  total_deliveries: number;
  rating: number;
  is_active: number;
}

interface ZoneRow {
  id: string;
  name: string;
  fee_cents: number;
  min_order_cents: number;
  estimated_minutes: number;
  is_active: number;
}

const STATUS_BADGE: Record<string, { class: string; label: string }> = {
  AVAILABLE: { class: "bg-saffron-100 text-saffron-700", label: "متاح" },
  BUSY: { class: "bg-amber-100 text-amber-700", label: "مشغول" },
  OFFLINE: { class: "bg-ink-100 text-ink-500", label: "غير متصل" },
  INACTIVE: { class: "bg-red-100 text-red-600", label: "غير نشط" },
  ASSIGNED: { class: "bg-blue-100 text-blue-700", label: "تم التعيين" },
  PICKED_UP: { class: "bg-purple-100 text-purple-700", label: "تم الاستلام" },
  IN_TRANSIT: { class: "bg-amber-100 text-amber-700", label: "قيد التوصيل" },
  DELIVERED: { class: "bg-saffron-100 text-saffron-700", label: "تم التوصيل" },
  FAILED: { class: "bg-red-100 text-red-600", label: "فشل" },
  CANCELLED: { class: "bg-ink-100 text-ink-500", label: "ملغي" },
};

function formatTime(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("ar-SA", { day: "numeric", month: "short" });
}

export default function DeliveryPage() {
  const { fmt } = useCurrency();
  const [tab, setTab] = useState<Tab>("active");
  const [activeDeliveries, setActiveDeliveries] = useState<ActiveDeliveryRow[]>([]);
  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [zones, setZones] = useState<ZoneRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDriverForm, setShowDriverForm] = useState(false);
  const [showZoneForm, setShowZoneForm] = useState(false);
  const [editingDriver, setEditingDriver] = useState<DriverRow | null>(null);
  const [editingZone, setEditingZone] = useState<ZoneRow | null>(null);

  const loadActive = useCallback(async () => {
    try {
      const data = await deliveryService.getActiveDeliveries();
      setActiveDeliveries(data as unknown as ActiveDeliveryRow[]);
    } catch (err) { console.error("Failed to load active deliveries:", err); setActiveDeliveries([]); }
  }, []);

  const loadDrivers = useCallback(async () => {
    try {
      const data = await deliveryService.getDrivers(true);
      setDrivers(data as unknown as DriverRow[]);
    } catch (err) { console.error("Failed to load drivers:", err); setDrivers([]); }
  }, []);

  const loadZones = useCallback(async () => {
    try {
      const data = await deliveryService.getZones();
      setZones(data as unknown as ZoneRow[]);
    } catch (err) { console.error("Failed to load zones:", err); setZones([]); }
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadActive(), loadDrivers(), loadZones()]);
    setLoading(false);
  }, [loadActive, loadDrivers, loadZones]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const handleUpdateStatus = async (logId: string, status: string) => {
    await deliveryService.updateDeliveryStatus(logId, status as any);
    loadActive();
    loadDrivers();
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-saffron-500/30 border-t-saffron-500 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" dir="rtl">
      <div className="h-14 shrink-0 flex items-center justify-between px-6 border-b border-ink-200 bg-white">
        <div className="flex items-center gap-3">
          <Truck className="w-5 h-5 text-saffron-600" />
          <h1 className="font-bold text-lg text-ink-800">إدارة التوصيل</h1>
        </div>
        <div className="flex gap-1 bg-ink-100 rounded-lg p-1">
          {[
            { id: "active" as Tab, icon: Navigation, label: "التوصيلات النشطة" },
            { id: "drivers" as Tab, icon: Users, label: "السائقين" },
            { id: "zones" as Tab, icon: MapPin, label: "المناطق" },
            { id: "history" as Tab, icon: History, label: "السجل" },
          ].map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-all ${
                  tab === t.id ? "bg-white text-saffron-700 font-medium shadow-sh-1" : "text-ink-500 hover:text-ink-700"
                }`}
              >
                <Icon className="w-4 h-4" />
                <span className="hidden sm:inline">{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6 space-y-4">
        {tab === "active" && (
          <ActiveDeliveriesView
            deliveries={activeDeliveries}
            fmt={fmt}
            onUpdateStatus={handleUpdateStatus}
            onRefresh={loadActive}
          />
        )}
        {tab === "drivers" && (
          <DriversView
            drivers={drivers}
            fmt={fmt}
            showForm={showDriverForm}
            editingDriver={editingDriver}
            onCloseForm={() => { setShowDriverForm(false); setEditingDriver(null); }}
            onSaved={() => { loadDrivers(); setShowDriverForm(false); setEditingDriver(null); }}
            onAdd={() => { setEditingDriver(null); setShowDriverForm(true); }}
            onEdit={(d) => { setEditingDriver(d); setShowDriverForm(true); }}
            onRefresh={loadDrivers}
          />
        )}
        {tab === "zones" && (
          <ZonesView
            zones={zones}
            fmt={fmt}
            showForm={showZoneForm}
            editingZone={editingZone}
            onCloseForm={() => { setShowZoneForm(false); setEditingZone(null); }}
            onSaved={() => { loadZones(); setShowZoneForm(false); setEditingZone(null); }}
            onAdd={() => { setEditingZone(null); setShowZoneForm(true); }}
            onEdit={(z) => { setEditingZone(z); setShowZoneForm(true); }}
            onRefresh={loadZones}
          />
        )}
        {tab === "history" && <DeliveryHistoryView fmt={fmt} />}
      </div>
    </div>
  );
}

function ActiveDeliveriesView({
  deliveries, fmt, onUpdateStatus, onRefresh,
}: {
  deliveries: ActiveDeliveryRow[];
  fmt: (c: number) => string;
  onUpdateStatus: (logId: string, status: string) => Promise<void>;
  onRefresh: () => void;
}) {
  if (deliveries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-ink-400">
        <Navigation className="w-12 h-12 mb-3" />
        <p className="text-lg font-medium">لا توجد توصيلات نشطة</p>
        <p className="text-sm">عند تعيين سائق لطلب توصيل، سيظهر هنا</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-ink-700">التوصيلات النشطة ({deliveries.length})</h2>
        <button onClick={onRefresh} className="text-sm text-saffron-600 hover:text-saffron-700">
          تحديث
        </button>
      </div>
      <div className="grid gap-3">
        {deliveries.map((d) => {
          const badge = STATUS_BADGE[d.delivery_status] || STATUS_BADGE.ASSIGNED;
          return (
            <div key={d.log_id} className="bg-white rounded-lg border border-ink-200 p-4 space-y-3">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-ink-800">{d.customer_name || "بدون اسم"}</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${badge.class}`}>{badge.label}</span>
                  </div>
                  {d.customer_phone && (
                    <div className="flex items-center gap-1.5 text-sm text-ink-500">
                      <Phone className="w-3.5 h-3.5" />
                      {d.customer_phone}
                    </div>
                  )}
                  {d.delivery_address && (
                    <div className="flex items-start gap-1.5 text-sm text-ink-500">
                      <MapPin className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>{d.delivery_address}</span>
                    </div>
                  )}
                </div>
                <div className="text-left">
                  <div className="font-bold text-saffron-600">{fmt(d.total_cents)}</div>
                  <div className="text-xs text-ink-400">{formatDate(d.assigned_at)} {formatTime(d.assigned_at)}</div>
                </div>
              </div>

              <div className="flex items-center gap-3 p-2 bg-ink-50 rounded-md">
                <div className="w-9 h-9 rounded-full bg-saffron-100 flex items-center justify-center text-saffron-600 font-bold text-sm shrink-0">
                  {d.driver_name[0]}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-ink-700">{d.driver_name}</p>
                  <p className="text-xs text-ink-400">
                    {d.vehicle_type === "MOTORCYCLE" ? "دراجة نارية" : d.vehicle_type === "CAR" ? "سيارة" : d.vehicle_type === "VAN" ? "فان" : "شاحنة"}
                    {d.vehicle_plate ? ` · ${d.vehicle_plate}` : ""}
                  </p>
                </div>
              </div>

              {d.delivery_status === "ASSIGNED" && (
                <div className="flex gap-2">
                  <button onClick={() => onUpdateStatus(d.log_id, "PICKED_UP")} className="flex-1 bg-purple-500 text-white rounded-md py-2 text-sm font-medium hover:bg-purple-600 transition-colors">
                    تم الاستلام
                  </button>
                  <button onClick={() => onUpdateStatus(d.log_id, "CANCELLED")} className="px-3 text-red-500 hover:text-red-600 text-sm">
                    إلغاء
                  </button>
                </div>
              )}
              {d.delivery_status === "PICKED_UP" && (
                <div className="flex gap-2">
                  <button onClick={() => onUpdateStatus(d.log_id, "IN_TRANSIT")} className="flex-1 bg-amber-500 text-white rounded-md py-2 text-sm font-medium hover:bg-amber-600 transition-colors">
                    قيد التوصيل
                  </button>
                  <button onClick={() => onUpdateStatus(d.log_id, "FAILED")} className="px-3 text-red-500 hover:text-red-600 text-sm">
                    فشل
                  </button>
                </div>
              )}
              {d.delivery_status === "IN_TRANSIT" && (
                <div className="flex gap-2">
                  <button onClick={() => onUpdateStatus(d.log_id, "DELIVERED")} className="flex-1 bg-saffron-500 text-white rounded-md py-2 text-sm font-medium hover:bg-saffron-600 transition-colors">
                    تم التوصيل
                  </button>
                  <button onClick={() => onUpdateStatus(d.log_id, "FAILED")} className="px-3 text-red-500 hover:text-red-600 text-sm">
                    فشل
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DriversView({
  drivers, showForm, editingDriver, onCloseForm, onSaved, onAdd, onEdit,
}: {
  drivers: DriverRow[];
  fmt: (c: number) => string;
  showForm: boolean;
  editingDriver: DriverRow | null;
  onCloseForm: () => void;
  onSaved: () => void;
  onAdd: () => void;
  onEdit: (d: DriverRow) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-ink-700">السائقين ({drivers.length})</h2>
        <button onClick={onAdd} className="flex items-center gap-1.5 px-3 py-1.5 bg-saffron-500 text-white rounded-md text-sm font-medium hover:bg-saffron-600 transition-colors">
          <Plus className="w-4 h-4" />
          إضافة سائق
        </button>
      </div>

      {showForm && (
        <DriverForm editing={editingDriver} onClose={onCloseForm} onSaved={onSaved} />
      )}

      <div className="grid gap-3">
        {drivers.map((d) => {
          const badge = STATUS_BADGE[d.status] || STATUS_BADGE.INACTIVE;
          const stars = Math.round(d.rating);
          return (
            <div key={d.id} className="bg-white rounded-lg border border-ink-200 p-4 flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-saffron-100 flex items-center justify-center text-saffron-600 font-bold shrink-0">
                {d.name[0]}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-ink-800">{d.name}</span>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${badge.class}`}>{badge.label}</span>
                </div>
                <div className="flex items-center gap-3 text-sm text-ink-500 mt-0.5">
                  <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{d.phone}</span>
                  <span className="flex items-center gap-1">
                    <Car className="w-3 h-3" />
                    {d.vehicle_type === "MOTORCYCLE" ? "دراجة نارية" : d.vehicle_type === "CAR" ? "سيارة" : d.vehicle_type === "VAN" ? "فان" : "شاحنة"}
                  </span>
                  {d.vehicle_plate && <span className="text-xs text-ink-400">{d.vehicle_plate}</span>}
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-ink-400">
                  <span>{d.total_deliveries} توصيلة</span>
                  <span className="flex items-center gap-0.5">
                    {Array.from({ length: 5 }, (_, i) => (
                      <Star key={i} className={`w-3 h-3 ${i < stars ? "text-amber-400 fill-amber-400" : "text-ink-200"}`} />
                    ))}
                  </span>
                </div>
              </div>
              <button onClick={() => onEdit(d)} className="text-sm text-saffron-600 hover:text-saffron-700 shrink-0">
                تعديل
              </button>
            </div>
          );
        })}
        {drivers.length === 0 && (
          <div className="text-center py-10 text-ink-400">
            <Users className="w-10 h-10 mx-auto mb-2" />
            <p>لا يوجد سائقين. أضف سائقاً للبدء</p>
          </div>
        )}
      </div>
    </div>
  );
}

function DriverForm({ editing, onClose, onSaved }: { editing: DriverRow | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(editing?.name || "");
  const [phone, setPhone] = useState(editing?.phone || "");
  const [vehicleType, setVehicleType] = useState(editing?.vehicle_type || "CAR");
  const [vehiclePlate, setVehiclePlate] = useState(editing?.vehicle_plate || "");
  const [licenseNumber, setLicenseNumber] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!name.trim() || !phone.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const update: Record<string, unknown> = {
        name: name.trim(),
        phone: phone.trim(),
        vehicle_type: vehicleType,
      };
      if (vehiclePlate.trim()) update.vehicle_plate = vehiclePlate.trim();
      if (licenseNumber.trim()) update.license_number = licenseNumber.trim();
      if (editing) {
        await deliveryService.updateDriver(editing.id, update as any);
      } else {
        await deliveryService.createDriver({
          name: name.trim(),
          phone: phone.trim(),
          vehicle_type: vehicleType as any,
          ...(vehiclePlate.trim() ? { vehicle_plate: vehiclePlate.trim() } : {}),
          ...(licenseNumber.trim() ? { license_number: licenseNumber.trim() } : {}),
        });
      }
      onSaved();
    } catch (err) {
      console.error("Failed to save driver:", err);
      setError("تعذر حفظ بيانات السائق");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-saffron-200 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-ink-700">{editing ? "تعديل سائق" : "إضافة سائق جديد"}</h3>
        <button onClick={onClose} className="text-ink-400 hover:text-ink-600"><X className="w-4 h-4" /></button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs text-ink-500 font-medium">الاسم</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full px-3 py-2 border border-ink-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500/20 focus:border-saffron-400" placeholder="اسم السائق" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-ink-500 font-medium">رقم الجوال</label>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full px-3 py-2 border border-ink-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500/20 focus:border-saffron-400" placeholder="05xxxxxxxx" dir="ltr" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-ink-500 font-medium">نوع المركبة</label>
          <select value={vehicleType} onChange={(e) => setVehicleType(e.target.value)} className="w-full px-3 py-2 border border-ink-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500/20 focus:border-saffron-400 bg-white">
            <option value="CAR">سيارة</option>
            <option value="MOTORCYCLE">دراجة نارية</option>
            <option value="VAN">فان</option>
            <option value="TRUCK">شاحنة</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-ink-500 font-medium">لوحة المركبة</label>
          <input value={vehiclePlate} onChange={(e) => setVehiclePlate(e.target.value)} className="w-full px-3 py-2 border border-ink-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500/20 focus:border-saffron-400" placeholder="أ ب 1234" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-ink-500 font-medium">رقم الترخيص</label>
          <input value={licenseNumber} onChange={(e) => setLicenseNumber(e.target.value)} className="w-full px-3 py-2 border border-ink-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500/20 focus:border-saffron-400" placeholder="رقم رخصة القيادة" />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        {error && <p className="text-sm text-red-500 flex-1">{error}</p>}
        <button onClick={onClose} className="px-4 py-2 text-sm text-ink-500 hover:text-ink-700">إلغاء</button>
        <button onClick={handleSave} disabled={saving || !name.trim() || !phone.trim()} className="px-4 py-2 bg-saffron-500 text-white rounded-md text-sm font-medium hover:bg-saffron-600 disabled:opacity-50 transition-colors">
          {saving ? "جاري الحفظ..." : editing ? "حفظ التغييرات" : "إضافة"}
        </button>
      </div>
    </div>
  );
}

function ZonesView({
  zones, fmt, showForm, editingZone, onCloseForm, onSaved, onAdd, onEdit,
}: {
  zones: ZoneRow[];
  fmt: (c: number) => string;
  showForm: boolean;
  editingZone: ZoneRow | null;
  onCloseForm: () => void;
  onSaved: () => void;
  onAdd: () => void;
  onEdit: (z: ZoneRow) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-ink-700">مناطق التوصيل ({zones.length})</h2>
        <button onClick={onAdd} className="flex items-center gap-1.5 px-3 py-1.5 bg-saffron-500 text-white rounded-md text-sm font-medium hover:bg-saffron-600 transition-colors">
          <Plus className="w-4 h-4" />
          إضافة منطقة
        </button>
      </div>

      {showForm && (
        <ZoneForm editing={editingZone} onClose={onCloseForm} onSaved={onSaved} />
      )}

      <div className="grid gap-3">
        {zones.map((z) => (
          <div key={z.id} className="bg-white rounded-lg border border-ink-200 p-4 flex items-center justify-between">
            <div className="space-y-1">
              <span className="font-semibold text-ink-800">{z.name}</span>
              <div className="flex items-center gap-3 text-sm text-ink-500">
                <span>رسوم التوصيل: {fmt(z.fee_cents)}</span>
                <span>أقل طلب: {z.min_order_cents > 0 ? fmt(z.min_order_cents) : "بدون"}</span>
                <span>الوقت المقدر: {z.estimated_minutes} دقيقة</span>
              </div>
            </div>
            <button onClick={() => onEdit(z)} className="text-sm text-saffron-600 hover:text-saffron-700">تعديل</button>
          </div>
        ))}
        {zones.length === 0 && (
          <div className="text-center py-10 text-ink-400">
            <MapPin className="w-10 h-10 mx-auto mb-2" />
            <p>لا توجد مناطق توصيل. أضف منطقة للبدء</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ZoneForm({ editing, onClose, onSaved }: { editing: ZoneRow | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(editing?.name || "");
  const [feeCents, setFeeCents] = useState(editing ? String(editing.fee_cents / 100) : "10");
  const [minOrderCents, setMinOrderCents] = useState(editing ? String(editing.min_order_cents / 100) : "0");
  const [estimatedMinutes, setEstimatedMinutes] = useState(editing ? String(editing.estimated_minutes) : "30");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const input = {
        name: name.trim(),
        fee_cents: Math.round(parseFloat(feeCents || "0") * 100),
        min_order_cents: Math.round(parseFloat(minOrderCents || "0") * 100),
        estimated_minutes: parseInt(estimatedMinutes || "30"),
      };
      if (editing) {
        await deliveryService.updateZone(editing.id, input);
      } else {
        await deliveryService.createZone(input);
      }
      onSaved();
    } catch (err) {
      console.error("Failed to save zone:", err);
      setError("تعذر حفظ المنطقة");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-saffron-200 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-ink-700">{editing ? "تعديل منطقة" : "إضافة منطقة جديدة"}</h3>
        <button onClick={onClose} className="text-ink-400 hover:text-ink-600"><X className="w-4 h-4" /></button>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1">
          <label className="text-xs text-ink-500 font-medium">اسم المنطقة</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full px-3 py-2 border border-ink-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500/20 focus:border-saffron-400" placeholder="مثال: حي النزهة" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-ink-500 font-medium">رسوم التوصيل (ريال)</label>
          <input value={feeCents} onChange={(e) => setFeeCents(e.target.value)} type="number" min="0" step="0.5" className="w-full px-3 py-2 border border-ink-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500/20 focus:border-saffron-400" dir="ltr" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-ink-500 font-medium">أقل قيمة للطلب (ريال)</label>
          <input value={minOrderCents} onChange={(e) => setMinOrderCents(e.target.value)} type="number" min="0" step="5" className="w-full px-3 py-2 border border-ink-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500/20 focus:border-saffron-400" dir="ltr" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-ink-500 font-medium">الوقت المقدر (دقيقة)</label>
          <input value={estimatedMinutes} onChange={(e) => setEstimatedMinutes(e.target.value)} type="number" min="5" max="180" className="w-full px-3 py-2 border border-ink-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-saffron-500/20 focus:border-saffron-400" dir="ltr" />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        {error && <p className="text-sm text-red-500 flex-1">{error}</p>}
        <button onClick={onClose} className="px-4 py-2 text-sm text-ink-500 hover:text-ink-700">إلغاء</button>
        <button onClick={handleSave} disabled={saving || !name.trim()} className="px-4 py-2 bg-saffron-500 text-white rounded-md text-sm font-medium hover:bg-saffron-600 disabled:opacity-50 transition-colors">
          {saving ? "جاري الحفظ..." : editing ? "حفظ التغييرات" : "إضافة"}
        </button>
      </div>
    </div>
  );
}

function DeliveryHistoryView({ fmt }: { fmt: (c: number) => string }) {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    deliveryService.getDeliveryHistory(100, 0).then((data) => {
      setLogs(data as any);
    }).catch((err) => { console.error("Failed to load delivery history:", err); setError("تعذر تحميل سجل التوصيل"); }).finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="flex justify-center py-10"><div className="w-6 h-6 border-2 border-saffron-500/30 border-t-saffron-500 rounded-full animate-spin" /></div>;
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-ink-400">
        <History className="w-12 h-12 mb-3" />
        <p className="text-lg font-medium text-red-500">{error}</p>
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-ink-400">
        <History className="w-12 h-12 mb-3" />
        <p className="text-lg font-medium">لا يوجد سجل توصيل</p>
        <p className="text-sm">سجل التوصيلات السابقة سيظهر هنا</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h2 className="font-semibold text-ink-700">سجل التوصيل ({logs.length})</h2>
      <div className="overflow-x-auto rounded-lg border border-ink-200">
        <table className="w-full text-sm">
          <thead className="bg-ink-50">
            <tr>
              <th className="text-right px-4 py-2.5 text-ink-500 font-medium">العميل</th>
              <th className="text-right px-4 py-2.5 text-ink-500 font-medium">السائق</th>
              <th className="text-right px-4 py-2.5 text-ink-500 font-medium">الحالة</th>
              <th className="text-right px-4 py-2.5 text-ink-500 font-medium">المبلغ</th>
              <th className="text-right px-4 py-2.5 text-ink-500 font-medium">التاريخ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {logs.map((log: any) => {
              const badge = STATUS_BADGE[log.delivery_status] || STATUS_BADGE.CANCELLED;
              return (
                <tr key={log.log_id} className="hover:bg-ink-50">
                  <td className="px-4 py-2.5 font-medium text-ink-700">{log.customer_name || "بدون اسم"}</td>
                  <td className="px-4 py-2.5 text-ink-600">{log.driver_name}</td>
                  <td className="px-4 py-2.5"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${badge.class}`}>{badge.label}</span></td>
                  <td className="px-4 py-2.5 text-ink-600">{fmt(log.total_cents)}</td>
                  <td className="px-4 py-2.5 text-ink-400 text-xs">{formatDate(log.assigned_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
