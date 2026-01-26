import { createFileRoute } from '@tanstack/react-router'
import '../App.css'
import { CssVarsProvider } from '@mui/joy/styles';
import Sheet from '@mui/joy/Sheet';
import CssBaseline from '@mui/joy/CssBaseline';

export const Route = createFileRoute('/')({ component: App })

export default function App() {
  return (
    <CssVarsProvider>
       <CssBaseline />
       <h1 className="text-3xl font-bold underline">
    Hello world!
  </h1>
      <Sheet variant="outlined">Welcome!</Sheet>
    </CssVarsProvider>
  );
}
