import {notFound} from 'next/navigation';
import {EventKioskRehearsal} from './EventKioskRehearsal';
export const dynamic='force-dynamic';
export default function Page(){if(process.env.NODE_ENV!=='development')notFound();return <EventKioskRehearsal/>;}
