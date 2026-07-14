import { useEffect, useState } from "react";
import * as deliveryService from "../../lib/deliveryService";
import { X, Car, Star, Phone } from "lucide-react";

interface Driver {
  id: string;
  name: string;
  phone: string;
  vehicle_type: string;
  vehicle_plate: string | null;
  status: string;
  rating: number;
  total_deliveries: number;
}

interface Props {
  selectedId: string | null;
  onSelect: (driverId: string) => void;
  onClose: () => void;
}

export default function DriverSelectModal({ selectedId, onSelect, onClose }: Props) {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    deliveryService.getAvailableDrivers().then((data) => {
      setDrivers(data as unknown as Driver[]);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-elevated w-[420px] max-h-[80vh] overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="font-bold text-lg text-slate-900">اختيار سائق التوصيل</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-2 overflow-y-auto max-h-[60vh]">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="w-6 h-6 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
            </div>
          ) : drivers.length === 0 ? (
            <div className="text-center py-8 text-slate-400">
              <Car className="w-10 h-10 mx-auto mb-2" />
              <p>لا يوجد سائقين متاحين حالياً</p>
              <p className="text-xs mt-1">تأكد من إضافة سائقين في قسم التوصيل</p>
            </div>
          ) : (
            drivers.map((d) => {
              const stars = Math.round(d.rating);
              const isSelected = selectedId === d.id;
              return (
                <button
                  key={d.id}
                  onClick={() => onSelect(d.id)}
                  className={`w-full p-3 rounded-xl border-2 text-right transition-all ${
                    isSelected
                      ? "border-emerald-500 bg-emerald-50"
                      : "border-slate-200 hover:border-emerald-200 hover:bg-emerald-50"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600 font-bold shrink-0">
                      {d.name[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-slate-800">{d.name}</div>
                      <div className="flex items-center gap-2 text-xs text-slate-500 mt-0.5">
                        <span className="flex items-center gap-1">
                          <Car className="w-3 h-3" />
                          {d.vehicle_type === "MOTORCYCLE" ? "دراجة نارية" : d.vehicle_type === "CAR" ? "سيارة" : d.vehicle_type === "VAN" ? "فان" : "شاحنة"}
                        </span>
                        {d.vehicle_plate && <span>{d.vehicle_plate}</span>}
                        <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{d.phone}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="flex items-center gap-0.5">
                          {Array.from({ length: 5 }, (_, i) => (
                            <Star key={i} className={`w-3 h-3 ${i < stars ? "text-amber-400 fill-amber-400" : "text-slate-200"}`} />
                          ))}
                        </span>
                        <span className="text-xs text-slate-400">{d.total_deliveries} توصيلة</span>
                      </div>
                    </div>
                    {isSelected && (
                      <span className="px-2 py-0.5 bg-emerald-500 text-white text-xs rounded-full">مختار</span>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
        <div className="px-6 py-4 border-t border-slate-200">
          <button
            onClick={onClose}
            className="w-full h-12 rounded-xl bg-white text-slate-900 font-bold hover:bg-slate-100 transition-colors"
          >
            {selectedId ? "تأكيد" : "إلغاء"}
          </button>
        </div>
      </div>
    </div>
  );
}
