import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import TradesList from './pages/TradesList'
import TradeDetail from './pages/TradeDetail'
import BrokerActivityPage from './pages/BrokerActivityPage'
import ProposalsAndOrders from './pages/ProposalsAndOrders'

function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="trades" element={<TradesList />} />
        <Route path="trades/:id" element={<TradeDetail />} />
        <Route path="broker" element={<BrokerActivityPage />} />
        <Route path="proposals" element={<ProposalsAndOrders />} />
      </Route>
    </Routes>
  )
}

export default App
