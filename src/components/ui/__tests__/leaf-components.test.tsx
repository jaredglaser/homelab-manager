import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Separator } from '@/components/ui/separator';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

describe('Badge', () => {
  it('renders variants with merged classes', () => {
    render(
      <>
        <Badge data-testid="default">A</Badge>
        <Badge data-testid="success" variant="success" className="px-3">
          B
        </Badge>
      </>,
    );
    expect(screen.getByTestId('default').className).toContain('bg-primary');
    const success = screen.getByTestId('success');
    expect(success.className).toContain('bg-success');
    expect(success.className).toContain('px-3');
  });
});

describe('Alert', () => {
  it('renders severity variants with title and description', () => {
    render(
      <Alert variant="error" data-testid="alert">
        <AlertTitle>Failed</AlertTitle>
        <AlertDescription>Something broke</AlertDescription>
      </Alert>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('text-destructive');
    expect(screen.getByText('Failed')).not.toBeNull();
    expect(screen.getByText('Something broke')).not.toBeNull();
  });
});

describe('Card', () => {
  it('renders all sections', () => {
    render(
      <Card data-testid="card">
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>Desc</CardDescription>
        </CardHeader>
        <CardContent>Body</CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>,
    );
    expect(screen.getByTestId('card').className).toContain('bg-card');
    for (const text of ['Title', 'Desc', 'Body', 'Footer']) {
      expect(screen.getByText(text)).not.toBeNull();
    }
  });
});

describe('Skeleton', () => {
  it('renders a pulsing placeholder', () => {
    render(<Skeleton data-testid="skeleton" className="h-4 w-20" />);
    const el = screen.getByTestId('skeleton');
    expect(el.className).toContain('animate-pulse');
    expect(el.className).toContain('w-20');
  });
});

describe('Spinner', () => {
  it('renders a spinning progressbar', () => {
    render(<Spinner className="size-5" />);
    const el = screen.getByRole('progressbar');
    expect(el.getAttribute('class')).toContain('animate-spin');
    expect(el.getAttribute('class')).toContain('size-5');
  });
});

describe('Separator', () => {
  it('renders horizontal and vertical orientations', () => {
    render(
      <>
        <Separator data-testid="h" />
        <Separator data-testid="v" orientation="vertical" />
      </>,
    );
    expect(screen.getByTestId('h').getAttribute('data-orientation')).toBe('horizontal');
    expect(screen.getByTestId('v').getAttribute('data-orientation')).toBe('vertical');
  });
});

describe('Label and Input', () => {
  it('associates label with input and accepts typing props', () => {
    render(
      <>
        <Label htmlFor="name">Name</Label>
        <Input id="name" placeholder="enter name" defaultValue="abc" />
      </>,
    );
    const input = screen.getByLabelText('Name') as HTMLInputElement;
    expect(input.value).toBe('abc');
    expect(input.className).toContain('rounded-lg');
  });
});
