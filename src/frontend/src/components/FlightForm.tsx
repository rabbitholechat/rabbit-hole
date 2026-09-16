import { useState, type FormEvent } from 'react'
import { Plane } from 'lucide-react'
import { Button } from './ui/button'
import type { Flight } from '../types'
import { useStore } from '../store'
export function FlightForm() {
  const [trip, setTrip] = useState<Flight['trip']>('round_trip')
  const run = useStore(s => s.run)
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const departure = String(form.get('departure')), returnDate = String(form.get('return_date') || '')
    if (trip === 'round_trip' && returnDate < departure) { (event.currentTarget.elements.namedItem('return_date') as HTMLInputElement).setCustomValidity('귀국일은 출발일 이후여야 합니다.'); event.currentTarget.reportValidity(); return }
    void run({ flight: { origin: String(form.get('origin')), departure, return_date: trip === 'round_trip' ? returnDate : null, trip,
      passengers: Number(form.get('passengers')), direct: form.get('direct') === 'yes', baggage: form.get('baggage') as Flight['baggage'] } })
  }
  return <form className="flight-form panel" onSubmit={submit} aria-label="항공권 검색 조건">
    <h2><Plane size={16}/> 같은 조건으로 비교해 볼까요?</h2>
    <div className="flight-fields">
      <label>출발 공항<input name="origin" placeholder="공항명 또는 코드" required minLength={2}/></label>
      <label>여정<select name="trip" value={trip} onChange={e => setTrip(e.target.value as Flight['trip'])}><option value="round_trip">왕복</option><option value="one_way">편도</option></select></label>
      <label>출발일<input type="date" name="departure" min={new Date().toLocaleDateString('en-CA')} required/></label>
      {trip === 'round_trip' && <label>귀국일<input type="date" name="return_date" required onChange={e => e.target.setCustomValidity('')}/></label>}
      <label>인원<input type="number" name="passengers" min={1} max={9} defaultValue={1} required/></label>
      <label>경유<select name="direct"><option value="yes">직항만</option><option value="no">경유 포함</option></select></label>
      <label>수하물<select name="baggage"><option value="cabin">기내 수하물</option><option value="checked">위탁 포함</option><option value="none">미포함</option></select></label>
    </div><div className="flight-footer"><p>실시간 운임 공급자 미연결 · 예약 가능 운임은 원문에서 확인하세요.</p><Button type="submit" size="sm">조건으로 검색</Button></div>
  </form>
}
