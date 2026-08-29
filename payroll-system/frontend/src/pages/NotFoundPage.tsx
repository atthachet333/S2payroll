import { Link } from 'react-router-dom';
import { Button, Card, EmptyState } from '@/components/ui';

export default function NotFoundPage() {
  return (
    <Card className="mx-auto max-w-lg">
      <EmptyState
        title="ไม่พบหน้าที่คุณต้องการ"
        description="หน้าที่คุณเข้าถึงอาจถูกย้ายหรือไม่มีอยู่ในระบบ"
        action={
          <Button asChild>
            <Link to="/">กลับสู่หน้าภาพรวม</Link>
          </Button>
        }
      />
    </Card>
  );
}
